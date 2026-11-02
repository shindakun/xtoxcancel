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
