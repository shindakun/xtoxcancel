// Slack bot that replies to x.com / twitter.com post links with the post's
// text, links, images and videos, as a Cloudflare Worker.
// Secrets required (set via `wrangler secret put`):
//   SLACK_SIGNING_SECRET
//   SLACK_BOT_TOKEN

import {
  buildFallback,
  buildMessage,
  extractStatusIds,
  fetchTweet,
} from "./tweet.js";

// Each post costs up to four subrequests (two APIs, the post, a plain text
// retry), and the Workers free plan allows 50 per invocation.
const MAX_POSTS_PER_MESSAGE = 5;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("ok", { status: 200 });
    }

    const rawBody = await request.text();

    // --- Verify Slack signature ---
    const timestamp = request.headers.get("x-slack-request-timestamp");
    const signature = request.headers.get("x-slack-signature");
    if (!timestamp || !signature) {
      return new Response("missing signature", { status: 401 });
    }
    // Reject replayed requests older than 5 minutes
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      return new Response("stale request", { status: 401 });
    }
    const valid = await verifySlackSignature(
      env.SLACK_SIGNING_SECRET,
      timestamp,
      rawBody,
      signature
    );
    if (!valid) {
      return new Response("bad signature", { status: 401 });
    }

    const payload = JSON.parse(rawBody);

    // Slack's one-time URL verification handshake
    if (payload.type === "url_verification") {
      return new Response(payload.challenge, {
        headers: { "content-type": "text/plain" },
      });
    }

    if (payload.type === "event_callback") {
      const event = payload.event || {};
      // Ignore bot messages (including our own) and message subtypes
      // (edits, deletes, joins, etc.)
      if (
        event.type === "message" &&
        !event.bot_id &&
        !event.subtype &&
        typeof event.text === "string"
      ) {
        const ids = extractStatusIds(event.text);
        if (ids.length > 0) {
          // Ack Slack immediately; post the replies after the response returns.
          ctx.waitUntil(replyWithTweets(env, event, ids));
        }
      }
    }

    return new Response("ok", { status: 200 });
  },

  // Daily sweep (cron in wrangler.toml): join any public channels the bot
  // isn't in yet, so new channels get covered automatically.
  // Requires scopes: channels:read, channels:join
  async scheduled(event, env, ctx) {
    let cursor;
    do {
      const url = new URL("https://slack.com/api/conversations.list");
      url.searchParams.set("types", "public_channel");
      url.searchParams.set("exclude_archived", "true");
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url, {
        headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      });
      const data = await res.json();
      if (!data.ok) {
        console.error("conversations.list failed:", data.error);
        return;
      }

      for (const ch of data.channels || []) {
        if (!ch.is_member) {
          const joinRes = await fetch(
            "https://slack.com/api/conversations.join",
            {
              method: "POST",
              headers: {
                "content-type": "application/json; charset=utf-8",
                authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
              },
              body: JSON.stringify({ channel: ch.id }),
            }
          );
          const joinData = await joinRes.json();
          if (!joinData.ok) {
            console.error(`join failed for ${ch.name}:`, joinData.error);
          }
        }
      }

      cursor = data.response_metadata?.next_cursor;
    } while (cursor);
  },
};

async function verifySlackSignature(secret, timestamp, body, signature) {
  const base = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base)
  );
  const computed =
    "v0=" +
    [...new Uint8Array(sigBytes)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return timingSafeEqual(computed, signature);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Fetches every post in parallel, then replies one message per post in the
// order the links appeared.
async function replyWithTweets(env, event, ids) {
  const shown = ids.slice(0, MAX_POSTS_PER_MESSAGE);
  const tweets = await Promise.all(shown.map((id) => fetchTweet(id)));
  for (const [i, tweet] of tweets.entries()) {
    const message = tweet ? buildMessage(tweet) : buildFallback(shown[i]);
    try {
      const ok = await postMessage(env.SLACK_BOT_TOKEN, event.channel, message, event.ts);
      // Slack rejects the whole message if it can't download an image, so
      // retry as plain text rather than dropping the reply.
      if (!ok && message.blocks) {
        await postMessage(env.SLACK_BOT_TOKEN, event.channel, { text: message.text }, event.ts);
      }
    } catch (err) {
      console.error(`reply for ${shown[i]} failed:`, err.message);
    }
  }
  const skipped = ids.length - shown.length;
  if (skipped > 0) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      event.channel,
      { text: `Showing the first ${shown.length} posts; skipped ${skipped} more.` },
      event.ts
    ).catch((err) => console.error("skip notice failed:", err.message));
  }
}

async function postMessage(token, channel, message, threadTs) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel,
      ...message,
      thread_ts: threadTs, // reply in-thread; remove to post in-channel
      unfurl_links: false, // the blocks already show the post
      unfurl_media: false,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("chat.postMessage failed:", data.error);
  }
  return data.ok;
}