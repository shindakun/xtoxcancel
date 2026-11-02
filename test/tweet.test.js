import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { fetchTweet } from "../tweet.js";

afterEach(() => mock.restoreAll());

function respondWith(body) {
  mock.method(globalThis, "fetch", async () => Response.json(body));
}

test("FxTwitter videos keep media id, duration and mp4 variants", async () => {
  respondWith({
    tweet: {
      id: "1",
      author: { name: "A", screen_name: "a" },
      text: "hi",
      media: {
        videos: [
          {
            id: "99",
            url: "https://video.twimg.com/1080.mp4",
            thumbnail_url: "https://pbs.twimg.com/thumb.jpg",
            duration: 9.3,
            variants: [
              { url: "https://video.twimg.com/pl.m3u8", bitrate: 0, content_type: "application/x-mpegURL" },
              { url: "https://video.twimg.com/360.mp4", bitrate: 832000, content_type: "video/mp4" },
            ],
          },
        ],
      },
    },
  });

  const tweet = await fetchTweet("1");

  assert.deepEqual(tweet.videos, [
    {
      id: "99",
      url: "https://video.twimg.com/1080.mp4",
      thumbnail: "https://pbs.twimg.com/thumb.jpg",
      duration: 9.3,
      variants: [{ url: "https://video.twimg.com/360.mp4", bitrate: 832000 }],
    },
  ]);
});

test("vxTwitter videos keep media id and URL", async () => {
  mock.method(globalThis, "fetch", async (url) =>
    url.includes("fxtwitter")
      ? new Response("down", { status: 500 })
      : Response.json({
          tweetID: "1",
          user_screen_name: "a",
          text: "hi",
          media_extended: [
            {
              type: "video",
              id_str: "99",
              url: "https://video.twimg.com/1080.mp4",
              thumbnail_url: "https://pbs.twimg.com/thumb.jpg",
              duration_millis: 9301,
            },
          ],
        })
  );
  mock.method(console, "error", () => {});

  const tweet = await fetchTweet("1");

  assert.deepEqual(tweet.videos, [
    {
      id: "99",
      url: "https://video.twimg.com/1080.mp4",
      thumbnail: "https://pbs.twimg.com/thumb.jpg",
      duration: 9.301,
      variants: [],
    },
  ]);
});
