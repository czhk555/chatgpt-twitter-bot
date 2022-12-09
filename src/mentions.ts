import delay from 'delay'
import pMap from 'p-map'
import urlRegex from 'url-regex'

import * as types from './types'
import {
  priorityUsersList,
  tweetIgnoreList,
  twitterBotHandle,
  twitterBotHandleL,
  twitterBotUserId
} from './config'
import { keyv } from './keyv'
import { maxTwitterId, minTwitterId } from './twitter'
import { getTweetUrl, pick } from './utils'

const rUrl = urlRegex()

/**
 * Fetches new unanswered mentions, preprocesses them, and sorts them by a
 * priority heuristic.
 */
export async function getTweetMentionsBatch({
  forceReply,
  debugTweet,
  resolveAllMentions,
  twitter,
  sinceMentionId,
  maxNumMentionsToProcess = 5
}: {
  forceReply?: boolean
  debugTweet?: string
  resolveAllMentions?: boolean
  twitter: types.TwitterClient
  sinceMentionId?: string
  maxNumMentionsToProcess?: number
}): Promise<types.TweetMentionBatch> {
  const batch: types.TweetMentionBatch = {
    mentions: [],
    users: {},
    tweets: {},
    minSinceMentionId: null,
    sinceMentionId: sinceMentionId,
    numMentionsPostponed: 0
  }

  function updateSinceMentionId(tweetId: string) {
    batch.sinceMentionId = maxTwitterId(batch.sinceMentionId, tweetId)
  }

  await populateTweetMentionsBatch({
    batch,
    debugTweet,
    resolveAllMentions,
    twitter
  })

  const numMentionsFetched = batch.mentions.length

  // Filter out invalid mentions
  batch.mentions = batch.mentions.filter((mention) =>
    isValidMention(mention, {
      batch,
      forceReply,
      updateSinceMentionId
    })
  )

  const numMentionsValid = batch.mentions.length

  // Sort the oldest mentions first
  batch.mentions = batch.mentions.reverse()

  // Filter any mentions which we've already replied to
  if (!forceReply) {
    batch.mentions = (
      await pMap(
        batch.mentions,
        async (mention) => {
          const res = await keyv.get(mention.id)
          if (res) {
            return null
          } else {
            return mention
          }
        },
        {
          concurrency: 8
        }
      )
    ).filter(Boolean)
  }

  const numMentionsCandidates = batch.mentions.length

  // Score every valid mention candidate according to a heuristic depending on
  // how important it is to respond to. Some factors taken into consideration:
  //    - top-level tweets are ranked higher than replies
  //    - accounts with lots of followers are prioritized because they have a
  //      larger surface area for exposure
  //    - a fixed set of "priority users" is prioritized highest for testing
  //      purposes; this includes me and my test accounts
  //    - older tweets that we haven't responded to yet get a small boost
  for (let i = 0; i < numMentionsCandidates; ++i) {
    const mention = batch.mentions[i]
    let score = (numMentionsCandidates - i) / numMentionsCandidates

    const repliedToTweetRef = mention.referenced_tweets?.find(
      (t) => t.type === 'replied_to'
    )
    const isReply = !!repliedToTweetRef
    mention.isReply = isReply

    if (isReply) {
      score -= 5
    }

    if (priorityUsersList.has(mention.author_id)) {
      score += 10000
    }

    const mentionUser = batch.users[mention.author_id]
    if (mentionUser) {
      mention.promptUrl = getTweetUrl({
        username: mentionUser.username,
        id: mention.id
      })

      const numFollowers = mentionUser?.public_metrics?.followers_count
      if (numFollowers) {
        mention.numFollowers = numFollowers
        score += numFollowers / 1000
      }
    }

    mention.priorityScore = score
  }

  // Sort mentions by relative priority, with the highest priority tweets first
  batch.mentions.sort((a, b) => b.priorityScore - a.priorityScore)

  // Loop through all of the mentions we won't be processing in this batch
  for (let i = maxNumMentionsToProcess; i < numMentionsCandidates; ++i) {
    const mention = batch.mentions[i]

    // make sure we don't skip past these mentions on the next batch
    batch.minSinceMentionId = minTwitterId(batch.minSinceMentionId, mention.id)
  }

  console.log('SORTED', batch.mentions)

  batch.numMentionsPostponed = Math.max(
    0,
    numMentionsCandidates - maxNumMentionsToProcess
  )

  // Limit the number of mentions to process in this batch
  batch.mentions = batch.mentions.slice(0, maxNumMentionsToProcess)

  const numMentionsInBatch = batch.mentions.length

  console.log(`fetched mentions batch`, {
    numMentionsFetched,
    numMentionsValid,
    numMentionsCandidates,
    numMentionsInBatch,
    numMentionsPostponed: batch.numMentionsPostponed
  })

  return batch
}

export async function populateTweetMentionsBatch({
  batch,
  debugTweet,
  resolveAllMentions,
  twitter
}: {
  batch: types.TweetMentionBatch
  debugTweet?: string
  resolveAllMentions?: boolean
  twitter: types.TwitterClient
}) {
  let sinceMentionId = batch.sinceMentionId
  console.log('fetching mentions since', sinceMentionId || 'forever')

  if (debugTweet) {
    const ids = debugTweet.split(',').map((id) => id.trim())
    const res = await twitter.tweets.findTweetsById({
      ids: ids,
      expansions: ['author_id', 'in_reply_to_user_id', 'referenced_tweets.id'],
      'tweet.fields': [
        'created_at',
        'public_metrics',
        'conversation_id',
        'in_reply_to_user_id',
        'referenced_tweets'
      ],
      'user.fields': ['profile_image_url', 'public_metrics']
    })

    batch.mentions = batch.mentions.concat(res.data)

    if (res.includes?.users?.length) {
      for (const user of res.includes.users) {
        batch.users[user.id] = user
      }
    }

    if (res.includes?.tweets?.length) {
      for (const tweet of res.includes.tweets) {
        batch.tweets[tweet.id] = tweet
      }
    }
  } else {
    let lastSinceMentionId = sinceMentionId

    do {
      console.log('twitter.tweets.usersIdMentions', { sinceMentionId })
      const mentionsQuery = twitter.tweets.usersIdMentions(twitterBotUserId, {
        expansions: [
          'author_id',
          'in_reply_to_user_id',
          'referenced_tweets.id'
        ],
        'tweet.fields': [
          'created_at',
          'public_metrics',
          'conversation_id',
          'in_reply_to_user_id',
          'referenced_tweets'
        ],
        'user.fields': ['profile_image_url', 'public_metrics'],
        max_results: 100,
        since_id: sinceMentionId
      })

      let numMentionsInQuery = 0
      let numPagesInQuery = 0
      for await (const page of mentionsQuery) {
        numPagesInQuery++

        if (page.data?.length) {
          numMentionsInQuery += page.data?.length
          batch.mentions = batch.mentions.concat(page.data)

          for (const mention of page.data) {
            sinceMentionId = maxTwitterId(sinceMentionId, mention.id)
          }
        }

        if (page.includes?.users?.length) {
          for (const user of page.includes.users) {
            batch.users[user.id] = user
          }
        }

        if (page.includes?.tweets?.length) {
          for (const tweet of page.includes.tweets) {
            batch.tweets[tweet.id] = tweet
          }
        }
      }

      console.log({ numMentionsInQuery, numPagesInQuery })
      if (
        !numMentionsInQuery ||
        !resolveAllMentions ||
        sinceMentionId === lastSinceMentionId
      ) {
        break
      }

      lastSinceMentionId = sinceMentionId
      console.log('pausing for twitter...')
      await delay(6000)
    } while (true)
  }
}

/**
 * Converts a Tweet text string to a prompt ready for input to ChatGPT.
 *
 * Strips usernames at the front of a tweet and URLs (like for embedding images).
 */
export function getPrompt(text?: string): string {
  // strip usernames
  let prompt = text
    .replace(twitterBotHandleL, '')
    .replace(twitterBotHandle, '')
    .trim()
    .replace(/^\s*@[a-zA-Z0-9_]+/g, '')
    .replace(/^\s*@[a-zA-Z0-9_]+/g, '')
    .replace(/^\s*@[a-zA-Z0-9_]+/g, '')
    .replace(/^\s*@[a-zA-Z0-9_]+/g, '')
    .replace(rUrl, '')
    .trim()
    .replace(/^,\s*/, '')
    .trim()

  // fix bug in plaintext version for code blocks
  // TODO: this should go in the response, not the prompt
  // prompt = prompt.replace('\n\nCopy code\n\n', '\n\n')

  return prompt
}

/**
 * Returns info on the mentions at the start of a tweet.
 *
 * @TODO Add unit tests for this
 */
export function getNumMentionsInText(
  text?: string,
  { isReply }: { isReply?: boolean } = {}
) {
  const prefixText = isReply
    ? (text.match(/^(\@[a-zA-Z0-9_]+\b\s*)+/g) || [])[0]
    : text
  if (!prefixText) {
    return {
      usernames: [],
      numMentions: 0
    }
  }

  const usernames = (prefixText.match(/\@[a-zA-Z0-9_]+\b/g) || []).map(
    (u: string) => u.trim().toLowerCase().replace(',', '')
  )
  let numMentions = 0

  for (const username of usernames) {
    if (username === twitterBotHandleL) {
      numMentions++
    }
  }

  return {
    numMentions,
    usernames
  }
}

/**
 * @returns `true` if the mention is valid to respond to; `false` otherwise
 */
export function isValidMention(
  mention: types.TweetMention,
  {
    batch,
    forceReply,
    updateSinceMentionId
  }: {
    batch: types.TweetMentionBatch
    forceReply?: boolean
    updateSinceMentionId: (string) => void
  }
): boolean {
  if (!mention) {
    return false
  }

  if (tweetIgnoreList.has(mention.id)) {
    return false
  }

  const text = mention.text
  mention.prompt = getPrompt(text)

  if (!mention.prompt) {
    return false
  }

  const repliedToTweetRef = mention.referenced_tweets?.find(
    (t) => t.type === 'replied_to'
  )
  const isReply = !!repliedToTweetRef
  const repliedToTweet = repliedToTweetRef
    ? batch.tweets[repliedToTweetRef.id]
    : null
  if (repliedToTweet) {
    repliedToTweet.prompt = getPrompt(repliedToTweet.text)
    const subMentions = getNumMentionsInText(repliedToTweet.text, {
      isReply: !!repliedToTweet.referenced_tweets?.find(
        (t) => t.type === 'replied_to'
      )
    })
    repliedToTweet.numMentions = subMentions.numMentions
  }

  const { numMentions, usernames } = getNumMentionsInText(text)

  if (
    numMentions > 0 &&
    (usernames[usernames.length - 1] === twitterBotHandleL ||
      (numMentions === 1 && !isReply))
  ) {
    if (
      isReply &&
      !forceReply &&
      (repliedToTweet?.numMentions > numMentions ||
        (repliedToTweet?.numMentions === numMentions &&
          repliedToTweet?.isReply))
    ) {
      console.log('ignoring mention 0', mention, {
        repliedToTweet,
        numMentions
      })

      updateSinceMentionId(mention.id)
      return false
    } else if (numMentions === 1) {
      // TODO: I don't think this is necessary anymore
      // if (isReply && mention.in_reply_to_user_id !== twitterBotUserId) {
      //   console.log('ignoring mention 1', mention, {
      //     numMentions
      //   })
      //   updateSinceMentionId(mention.id)
      //   return false
      // }
    }
  } else {
    console.log('ignoring mention 2', pick(mention, 'text', 'id'), {
      numMentions
    })

    updateSinceMentionId(mention.id)
    return false
  }

  console.log(JSON.stringify(mention, null, 2), {
    numMentions,
    repliedToTweet
  })
  // console.log(pick(mention, 'id', 'text', 'prompt'), { numMentions })
  return true
}
