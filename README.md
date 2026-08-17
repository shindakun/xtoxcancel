# xtoxcancel

A Slack bot that watches for x.com and twitter.com links and replies in-thread
with the same link pointed at xcancel.com, so you can read the post without an
account.

It runs as a single Cloudflare Worker. No database, no dependencies, one file.

## How it works

`worker.js` does two things:

- **fetch**: handles Slack event webhooks. It verifies the Slack signature,
  answers the URL verification handshake, and for regular user messages pulls
  out any x.com/twitter.com paths and posts them back as xcancel.com links.
  The reply goes out via `ctx.waitUntil` so Slack gets its 200 right away.
- **scheduled**: runs daily at 09:00 UTC and joins any public channel the bot
  isn't in yet. That way you don't have to invite it to new channels by hand.

Bot messages and message subtypes (edits, joins, deletes) are ignored, so it
won't reply to itself or spam on channel noise.

## Setup

You need a Cloudflare account and a Slack app.

### 1. Slack app

Create an app at https://api.slack.com/apps and give the bot token these scopes
under OAuth & Permissions:

| Scope | Why |
| --- | --- |
| `chat:write` | post the replies |
| `channels:history` | receive `message.channels` events |
| `channels:read` | list public channels for the cron sweep |
| `channels:join` | let the bot join those channels itself |

Install it to your workspace and grab the bot token (`xoxb-...`). The signing
secret is on the Basic Information page.

### 2. Deploy the worker

```sh
npx wrangler deploy
```

Then set the secrets:

```sh
echo -n "your-signing-secret" | npx wrangler secret put SLACK_SIGNING_SECRET
echo -n "xoxb-your-bot-token" | npx wrangler secret put SLACK_BOT_TOKEN
```

### 3. Point Slack at it

Back in the Slack app, under Event Subscriptions, set the request URL to your
worker's URL. Slack will send the verification handshake immediately, and the
worker answers it as long as the signing secret is already set. Subscribe to
the bot event `message.channels`, then reinstall the app if Slack asks.

## Local development

```sh
npx wrangler dev
```

Put the secrets in a `.dev.vars` file for local runs:

```
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=...
```

`.dev.vars` is gitignored. Don't commit it.

## Notes

- Replies are threaded. If you'd rather have them in-channel, drop the
  `thread_ts` field in `postMessage`.
- `unfurl_links` is off so you don't get two link previews stacked up.
- Requests with a timestamp more than 5 minutes old are rejected as replays.
