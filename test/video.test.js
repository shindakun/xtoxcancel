import { test } from "node:test";
import assert from "node:assert/strict";
import { pickVariant } from "../video.js";

const MB = 1024 * 1024;

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
