import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../worker.js";

const ORIGIN = "https://bot.example.workers.dev";
const SECRET = "signing-secret";

afterEach(() => mock.restoreAll());

function slackEvent(event) {
  const body = JSON.stringify({ type: "event_callback", event });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
  return new Request(ORIGIN, {
    method: "POST",
    headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

function backgroundTasks() {
  const tasks = [];
  return { tasks, waitUntil: (p) => tasks.push(p) };
}

const POST_WITH_VIDEO = {
  tweet: {
    id: "1",
    author: { name: "A", screen_name: "a" },
    text: "watch this",
    media: {
      videos: [
        {
          id: "99",
          url: "https://video.twimg.com/1080.mp4",
          duration: 9,
          variants: [{ url: "https://video.twimg.com/360.mp4", bitrate: 832000, content_type: "video/mp4" }],
        },
      ],
    },
  },
};

function fakeServices() {
  const posted = [];
  mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.fxtwitter.com/")) return Response.json(POST_WITH_VIDEO);
    if (url.startsWith("https://video.twimg.com/")) {
      return new Response("mp4 bytes", { headers: { "content-length": "9" } });
    }
    if (url === "https://slack.com/api/chat.postMessage") {
      posted.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return posted;
}

function emptyBucket() {
  const objects = new Map();
  return {
    objects,
    head: async (key) => (objects.has(key) ? {} : null),
    put: async (key, body) => objects.set(key, await new Response(body).text()),
  };
}

function bucketWith(key, bytes) {
  return {
    async get(k) {
      if (k !== key) return null;
      return {
        body: bytes,
        size: bytes.length,
        httpEtag: '"etag"',
        writeHttpMetadata(headers) {
          headers.set("content-type", "video/mp4");
        },
      };
    },
  };
}

test("GET /video/<id>.mp4 plays the copy from R2", async () => {
  const env = { VIDEOS: bucketWith("99.mp4", "mp4 bytes") };

  const res = await worker.fetch(new Request(`${ORIGIN}/video/99.mp4`), env, {});

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "mp4 bytes");
});

test("GET /video/<id>.mp4 answers 404 when no bucket is bound", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/video/99.mp4`), {}, {});

  assert.equal(res.status, 404);
});

test("replies to a post link with a play link to the worker's copy", async () => {
  const posted = fakeServices();
  const env = { SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: "xoxb", VIDEOS: emptyBucket() };
  const ctx = backgroundTasks();

  await worker.fetch(
    slackEvent({ type: "message", channel: "C1", ts: "1.0", text: "<https://x.com/a/status/1>" }),
    env,
    ctx
  );
  await Promise.all(ctx.tasks);

  assert.equal(env.VIDEOS.objects.get("99.mp4"), "mp4 bytes");
  assert.match(JSON.stringify(posted[0].blocks), /<https:\/\/bot\.example\.workers\.dev\/video\/99\.mp4\|Play video>/);
});

test("HEAD /video/<id>.mp4 is answered by the video route", async () => {
  const env = { VIDEOS: { head: async () => null } };

  const res = await worker.fetch(new Request(`${ORIGIN}/video/99.mp4`, { method: "HEAD" }), env, {});

  assert.equal(res.status, 404);
});

test("the daily cron prunes video copies even when the Slack sweep throws", async () => {
  mock.method(globalThis, "fetch", async () => new Response("<html>bad gateway</html>"));
  mock.method(console, "error", () => {});
  const deleted = [];
  const VIDEOS = {
    list: async () => ({
      objects: [{ key: "1.mp4", size: 10 * 1024 ** 3, uploaded: new Date() }],
      truncated: false,
    }),
    delete: async (keys) => deleted.push(...keys),
  };

  await worker.scheduled({}, { SLACK_BOT_TOKEN: "xoxb", VIDEOS }, {});

  assert.deepEqual(deleted, ["1.mp4"]);
});

test("the daily cron skips pruning when no bucket is bound", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ ok: true, channels: [] }));
  const errors = mock.method(console, "error", () => {});

  await worker.scheduled({}, { SLACK_BOT_TOKEN: "xoxb" }, {});

  assert.equal(errors.mock.callCount(), 0);
});

test("the daily cron still joins channels when pruning fails", async () => {
  const slack = mock.method(globalThis, "fetch", async () => Response.json({ ok: true, channels: [] }));
  mock.method(console, "error", () => {});
  const VIDEOS = { list: async () => { throw new Error("R2 down"); } };

  await worker.scheduled({}, { SLACK_BOT_TOKEN: "xoxb", VIDEOS }, {});

  assert.equal(slack.mock.callCount(), 1);
});
