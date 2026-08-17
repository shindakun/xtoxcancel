// Slack x.com → xcancel.com link bot, as a Cloudflare Worker.
// Secrets required (set via `wrangler secret put`):
//   SLACK_SIGNING_SECRET
//   SLACK_BOT_TOKEN

// Matches x.com / twitter.com links. Slack wraps URLs in <...> and may append
// |label, so exclude '>', '|', and whitespace from the path.
const X_LINK = /https?:\/\/(?:www\.)?(?:x|twitter)\.com(\/[^>|\s]+)/g;

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
        const paths = [...event.text.matchAll(X_LINK)].map((m) => m[1]);
        if (paths.length > 0) {
          const text = paths
            .map((p) => `https://xcancel.com${p}`)
            .join("\n");
          // Ack Slack immediately; post the reply after the response returns.
          ctx.waitUntil(
            postMessage(env.SLACK_BOT_TOKEN, event.channel, text, event.ts)
          );
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

async function postMessage(token, channel, text, threadTs) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs, // reply in-thread; remove to post in-channel
      unfurl_links: false, // avoid double link previews
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("chat.postMessage failed:", data.error);
  }
}