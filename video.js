// Copies post videos from video.twimg.com into R2 so people without an X
// account can play them, and serves those copies back from the worker.

export function pickVariant(video, maxBytes) {
  const byBitrate = [...video.variants].sort((a, b) => b.bitrate - a.bitrate);
  const fits = byBitrate.find((v) => (v.bitrate * video.duration) / 8 <= maxBytes);
  return (fits ?? byBitrate.at(-1) ?? video).url;
}

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
// Replies wait on the copy, and waitUntil stops 30 s after Slack's ack.
const VIDEO_TIMEOUT_MS = 15000;

export async function rehostVideo(
  bucket,
  video,
  origin,
  { maxBytes = MAX_VIDEO_BYTES, timeoutMs = VIDEO_TIMEOUT_MS } = {}
) {
  const key = `${video.id}.mp4`;
  if (!(await bucket.head(key))) {
    const res = await fetch(pickVariant(video, maxBytes), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const length = Number(res.headers.get("content-length"));
    if (!res.ok || !length || length > maxBytes) return null;
    await bucket.put(key, res.body, { httpMetadata: { contentType: "video/mp4" } });
  }
  return `${origin}/video/${key}`;
}

// A copy costs three subrequests (R2 head, the download, R2 put). Five posts
// take up to 21 of the free plan's 50, so eight copies keeps us under it.
const MAX_VIDEOS_PER_MESSAGE = 8;

export async function rehostVideos(tweets, bucket, origin, { limit = MAX_VIDEOS_PER_MESSAGE } = {}) {
  if (!bucket) return;
  const videos = tweets
    .filter(Boolean)
    .flatMap((t) => [...t.videos, ...(t.quote?.videos || [])])
    .filter((v) => /^\d+$/.test(v.id))
    .slice(0, limit);
  await Promise.all(
    videos.map(async (v) => {
      try {
        const hosted = await rehostVideo(bucket, v, origin);
        if (hosted) v.url = hosted;
        else console.error(`could not copy video ${v.id}`);
      } catch (err) {
        console.error(`copying video ${v.id} failed:`, err.message);
      }
    })
  );
}

export async function serveVideo(request, bucket) {
  const key = new URL(request.url).pathname.match(/^\/video\/(\d+\.mp4)$/)?.[1];
  if (!key || !bucket) return notFound();
  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object) return notFound();
    const headers = videoHeaders(object);
    headers.set("content-length", String(object.size));
    return new Response(null, { headers });
  }
  let ranged = request.headers.has("range");
  let object;
  try {
    object = await bucket.get(key, ranged ? { range: request.headers } : {});
  } catch {
    // R2 throws on a range it can't satisfy; ignoring Range is allowed.
    ranged = false;
    object = await bucket.get(key);
  }
  if (!object) return notFound();
  const headers = videoHeaders(object);
  if (!ranged) return new Response(object.body, { headers });
  const { offset, length, suffix } = object.range;
  const first = suffix ? object.size - suffix : offset;
  const last = length ? first + length - 1 : object.size - 1;
  headers.set("content-range", `bytes ${first}-${last}/${object.size}`);
  return new Response(object.body, { status: 206, headers });
}

function notFound() {
  return new Response("not found", { status: 404 });
}

// A media id's bytes never change, so the copy can be cached forever.
function videoHeaders(object) {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
    etag: object.httpEtag,
  });
  object.writeHttpMetadata(headers);
  return headers;
}
