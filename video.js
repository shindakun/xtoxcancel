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

// Cleanup goes by upload time, so a copy that's linked again gets re-saved
// rather than expiring under a link posted today.
const REFRESH_AFTER_MS = 30 * 24 * 3600 * 1000;
const VIDEO_METADATA = { httpMetadata: { contentType: "video/mp4" } };

export async function rehostVideo(
  bucket,
  video,
  origin,
  { maxBytes = MAX_VIDEO_BYTES, timeoutMs = VIDEO_TIMEOUT_MS } = {}
) {
  const key = `${video.id}.mp4`;
  const stored = await bucket.head(key);
  if (stored) {
    if (Date.now() - stored.uploaded > REFRESH_AFTER_MS) await resave(bucket, key);
  } else {
    const res = await fetch(pickVariant(video, maxBytes), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const length = Number(res.headers.get("content-length"));
    if (!res.ok || !length || length > maxBytes) {
      await res.body?.cancel();
      return null;
    }
    await bucket.put(key, res.body, VIDEO_METADATA);
  }
  return `${origin}/video/${key}`;
}

async function resave(bucket, key) {
  const object = await bucket.get(key);
  await bucket.put(key, object.body, VIDEO_METADATA);
}

// A copy costs three subrequests (R2 head, the download, R2 put). Five posts
// take up to 21 of the free plan's 50, so eight copies keeps us under it.
const MAX_VIDEOS_PER_MESSAGE = 8;

export async function rehostVideos(tweets, bucket, origin, { limit = MAX_VIDEOS_PER_MESSAGE } = {}) {
  if (!bucket) return;
  const byId = Map.groupBy(
    tweets
      .filter(Boolean)
      .flatMap((t) => [...t.videos, ...(t.quote?.videos || [])])
      .filter((v) => /^\d+$/.test(v.id)),
    (v) => v.id
  );
  await Promise.all(
    [...byId.values()].slice(0, limit).map(async (copies) => {
      const [v] = copies;
      try {
        const hosted = await rehostVideo(bucket, v, origin);
        if (hosted) for (const c of copies) c.url = hosted;
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

// R2's free tier is 10 GB (decimal). Pruning runs once a day, so this leaves
// 2 GB for a day of new copies, about 40 at the 50 MB cap.
const STORAGE_BUDGET_BYTES = 8e9;

// Deletes the oldest copies until the bucket fits in the budget.
export async function pruneVideos(bucket, { budgetBytes = STORAGE_BUDGET_BYTES } = {}) {
  if (!bucket) return;
  const objects = await listAll(bucket);
  let total = objects.reduce((sum, o) => sum + o.size, 0);
  const doomed = [];
  for (const o of objects.sort((a, b) => a.uploaded - b.uploaded)) {
    if (total <= budgetBytes) break;
    doomed.push(o.key);
    total -= o.size;
  }
  // R2 deletes at most 1000 keys per call.
  for (let i = 0; i < doomed.length; i += 1000) {
    await bucket.delete(doomed.slice(i, i + 1000));
  }
}

async function listAll(bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
