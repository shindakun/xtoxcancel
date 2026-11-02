import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { pickVariant, rehostVideo, rehostVideos, serveVideo } from "../video.js";

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
    // Mirrors R2: `range` is set even with no Range header, comes back as
    // {offset}, {offset, length} or {suffix}, and a bad header throws.
    async get(key, options) {
      const stored = objects.get(key);
      if (!stored) return null;
      const size = stored.bytes.length;
      const header = options?.range?.get?.("range");
      const [, start, end] = header?.match(/^bytes=(\d*)-(\d*)$/) ?? [];
      if (header && (start === undefined || (!start && !end) || start >= size)) {
        throw new Error("get: The requested range is not satisfiable (10039)");
      }
      let range = { offset: 0, length: size };
      if (start && end) range = { offset: Number(start), length: end - start + 1 };
      else if (start) range = { offset: Number(start) };
      else if (end) range = { suffix: Number(end) };
      const from = range.suffix ? size - range.suffix : range.offset;
      const to = range.length ? from + range.length : size;
      return {
        body: stored.bytes.slice(from, to),
        size,
        range,
        httpEtag: '"etag"',
        writeHttpMetadata(headers) {
          headers.set("content-type", stored.httpMetadata.contentType);
        },
      };
    },
  };
}

function storedVideo(bytes) {
  const bucket = fakeBucket();
  bucket.objects.set("99.mp4", { bytes, httpMetadata: { contentType: "video/mp4" } });
  return bucket;
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

test("serves a stored video", async () => {
  const bucket = storedVideo("mp4 bytes");

  const res = await serveVideo(new Request(`${ORIGIN}/video/99.mp4`), bucket);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("etag"), '"etag"');
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await res.text(), "mp4 bytes");
});

test("answers 404 for a video that is not stored", async () => {
  const res = await serveVideo(new Request(`${ORIGIN}/video/12.mp4`), storedVideo("mp4"));

  assert.equal(res.status, 404);
});

test("answers 404 without reading R2 for a path that is not a video key", async () => {
  const bucket = storedVideo("mp4");
  const get = mock.method(bucket, "get");

  const res = await serveVideo(new Request(`${ORIGIN}/video/99.mp4/../secret`), bucket);

  assert.equal(res.status, 404);
  assert.equal(get.mock.callCount(), 0);
});

test("serves the requested byte range of a stored video", async () => {
  const bucket = storedVideo("mp4 bytes");
  const request = new Request(`${ORIGIN}/video/99.mp4`, { headers: { range: "bytes=0-2" } });

  const res = await serveVideo(request, bucket);

  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 0-2/9");
  assert.equal(await res.text(), "mp4");
});

for (const [range, contentRange, body] of [
  ["bytes=4-", "bytes 4-8/9", "bytes"],
  ["bytes=-5", "bytes 4-8/9", "bytes"],
]) {
  test(`answers ${range} with content-range ${contentRange}`, async () => {
    const request = new Request(`${ORIGIN}/video/99.mp4`, { headers: { range } });

    const res = await serveVideo(request, storedVideo("mp4 bytes"));

    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), contentRange);
    assert.equal(await res.text(), body);
  });
}

test("sends the whole video when R2 cannot satisfy the requested range", async () => {
  const request = new Request(`${ORIGIN}/video/99.mp4`, { headers: { range: "bytes=50-" } });

  const res = await serveVideo(request, storedVideo("mp4 bytes"));

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "mp4 bytes");
});
