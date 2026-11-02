import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { pickVariant, rehostVideo, rehostVideos } from "../video.js";

const MB = 1024 * 1024;
const ORIGIN = "https://bot.example.workers.dev";

afterEach(() => mock.restoreAll());

function fakeBucket() {
  const objects = new Map();
  return {
    objects,
    async head(key) {
      return objects.has(key) ? { key } : null;
    },
    async put(key, body, options) {
      objects.set(key, { bytes: await new Response(body).text(), ...options });
    },
  };
}

function twimgServes(bytes) {
  return mock.method(globalThis, "fetch", async () =>
    new Response(bytes, {
      headers: { "content-type": "video/mp4", "content-length": String(bytes.length) },
    })
  );
}

const VIDEO = { id: "99", url: "https://video.twimg.com/1080.mp4", duration: 10, variants: [] };

test("picks the highest-bitrate mp4 that fits the size cap", () => {
  const video = {
    url: "https://video.twimg.com/1080.mp4",
    duration: 10,
    variants: [
      { url: "https://video.twimg.com/360.mp4", bitrate: 832_000 },
      { url: "https://video.twimg.com/720.mp4", bitrate: 2_176_000 },
      { url: "https://video.twimg.com/1080.mp4", bitrate: 10_368_000 },
    ],
  };

  assert.equal(pickVariant(video, 5 * MB), "https://video.twimg.com/720.mp4");
});

test("falls back to the lowest-bitrate mp4 when none fit", () => {
  const video = {
    url: "https://video.twimg.com/1080.mp4",
    duration: 600,
    variants: [
      { url: "https://video.twimg.com/720.mp4", bitrate: 2_176_000 },
      { url: "https://video.twimg.com/360.mp4", bitrate: 832_000 },
    ],
  };

  assert.equal(pickVariant(video, 5 * MB), "https://video.twimg.com/360.mp4");
});

test("uses the plain URL when a video has no variants", () => {
  const video = { url: "https://video.twimg.com/only.mp4", duration: 10, variants: [] };

  assert.equal(pickVariant(video, 5 * MB), "https://video.twimg.com/only.mp4");
});

test("rehosting stores the mp4 in R2 and returns the worker URL", async () => {
  const bucket = fakeBucket();
  twimgServes("mp4 bytes");

  const url = await rehostVideo(bucket, VIDEO, ORIGIN);

  assert.equal(url, `${ORIGIN}/video/99.mp4`);
  assert.equal(bucket.objects.get("99.mp4").bytes, "mp4 bytes");
  assert.equal(bucket.objects.get("99.mp4").httpMetadata.contentType, "video/mp4");
});

test("rehosting skips the download when the video is already stored", async () => {
  const bucket = fakeBucket();
  bucket.objects.set("99.mp4", { bytes: "already here" });
  const fetchMock = twimgServes("mp4 bytes");

  const url = await rehostVideo(bucket, VIDEO, ORIGIN);

  assert.equal(url, `${ORIGIN}/video/99.mp4`);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("rehosting refuses a source larger than the cap", async () => {
  const bucket = fakeBucket();
  twimgServes("x".repeat(100));

  const url = await rehostVideo(bucket, VIDEO, ORIGIN, { maxBytes: 50 });

  assert.equal(url, null);
  assert.equal(bucket.objects.size, 0);
});

test("rehosting refuses a source that does not say how big it is", async () => {
  const bucket = fakeBucket();
  mock.method(globalThis, "fetch", async () => new Response("mp4 bytes"));

  const url = await rehostVideo(bucket, VIDEO, ORIGIN, { maxBytes: 50 });

  assert.equal(url, null);
  assert.equal(bucket.objects.size, 0);
});

test("rehosting returns null when the source answers with an error", async () => {
  const bucket = fakeBucket();
  mock.method(globalThis, "fetch", async () =>
    new Response("nope", { status: 403, headers: { "content-length": "4" } })
  );

  const url = await rehostVideo(bucket, VIDEO, ORIGIN, { maxBytes: 50 });

  assert.equal(url, null);
  assert.equal(bucket.objects.size, 0);
});

test("rehosting gives up on a source that takes too long", async () => {
  const bucket = fakeBucket();
  mock.method(globalThis, "fetch", (url, init) =>
    new Promise((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason))
    )
  );

  await assert.rejects(rehostVideo(bucket, VIDEO, ORIGIN, { timeoutMs: 10 }), {
    name: "TimeoutError",
  });
});

function postWithVideos(...ids) {
  return {
    videos: ids.map((id) => ({ ...VIDEO, id, url: `https://video.twimg.com/${id}.mp4` })),
    quote: null,
  };
}

test("rehostVideos points every video, quoted ones included, at the worker", async () => {
  const bucket = fakeBucket();
  twimgServes("mp4 bytes");
  const post = postWithVideos("1");
  post.quote = postWithVideos("2");

  await rehostVideos([post], bucket, ORIGIN);

  assert.equal(post.videos[0].url, `${ORIGIN}/video/1.mp4`);
  assert.equal(post.quote.videos[0].url, `${ORIGIN}/video/2.mp4`);
});

test("rehostVideos keeps the X link for a video it could not copy", async () => {
  const bucket = fakeBucket();
  mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/1.mp4")) throw new Error("connection reset");
    return new Response("nope", { status: 404, headers: { "content-length": "4" } });
  });
  mock.method(console, "error", () => {});
  const post = postWithVideos("1", "2");

  await rehostVideos([post], bucket, ORIGIN);

  assert.deepEqual(
    post.videos.map((v) => v.url),
    ["https://video.twimg.com/1.mp4", "https://video.twimg.com/2.mp4"]
  );
});

test("rehostVideos skips posts that failed to load", async () => {
  const bucket = fakeBucket();
  twimgServes("mp4 bytes");
  const post = postWithVideos("1");

  await rehostVideos([null, post], bucket, ORIGIN);

  assert.equal(post.videos[0].url, `${ORIGIN}/video/1.mp4`);
});

test("rehostVideos copies at most `limit` videos and links the rest to X", async () => {
  const bucket = fakeBucket();
  twimgServes("mp4 bytes");
  const post = postWithVideos("1", "2", "3");

  await rehostVideos([post], bucket, ORIGIN, { limit: 2 });

  assert.deepEqual(
    post.videos.map((v) => v.url),
    [`${ORIGIN}/video/1.mp4`, `${ORIGIN}/video/2.mp4`, "https://video.twimg.com/3.mp4"]
  );
});

test("rehostVideos leaves a video without a numeric media id on X", async () => {
  const bucket = fakeBucket();
  twimgServes("mp4 bytes");
  const post = postWithVideos(undefined, "../etc");

  await rehostVideos([post], bucket, ORIGIN);

  assert.equal(bucket.objects.size, 0);
  assert.deepEqual(
    post.videos.map((v) => v.url),
    ["https://video.twimg.com/undefined.mp4", "https://video.twimg.com/../etc.mp4"]
  );
});

test("rehostVideos leaves videos on X when no bucket is bound", async () => {
  const fetchMock = twimgServes("mp4 bytes");
  const errors = mock.method(console, "error", () => {});
  const post = postWithVideos("1");

  await rehostVideos([post], undefined, ORIGIN);

  assert.equal(post.videos[0].url, "https://video.twimg.com/1.mp4");
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(errors.mock.callCount(), 0);
});
