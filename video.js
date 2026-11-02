// Copies post videos from video.twimg.com into R2 so people without an X
// account can play them, and serves those copies back from the worker.

export function pickVariant(video, maxBytes) {
  const byBitrate = [...video.variants].sort((a, b) => b.bitrate - a.bitrate);
  const fits = byBitrate.find((v) => (v.bitrate * video.duration) / 8 <= maxBytes);
  return (fits ?? byBitrate.at(-1) ?? video).url;
}
