// Fetch a post by status ID from the public FxTwitter API, falling back to
// vxTwitter, and turn it into a Slack Block Kit message.

// Matches status links on x.com / twitter.com, including /i/status/ and
// /i/web/status/ forms. Slack wraps URLs in <...>, so the ID is the only part
// we need and anything after it is ignored.
export const STATUS_LINK =
  /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?|i(?:\/web)?\/status)\/(\d{1,20})/g;

const USER_AGENT = "xtoxcancel-slack-bot (+https://github.com/shindakun/xtoxcancel)";
const FETCH_TIMEOUT_MS = 5000;
const MAX_TEXT = 2900; // Slack caps section text at 3000 chars

export function extractStatusIds(text) {
  const ids = [...text.matchAll(STATUS_LINK)].map((m) => m[1]);
  return [...new Set(ids)];
}

// Returns a normalized post, or null if every source failed.
export async function fetchTweet(id) {
  const sources = [
    [`https://api.fxtwitter.com/status/${id}`, fromFx],
    [`https://api.vxtwitter.com/status/${id}`, fromVx],
  ];
  for (const [url, normalize] of sources) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`${url} returned ${res.status}`);
        continue;
      }
      const tweet = normalize(await res.json());
      if (tweet) return tweet;
      console.error(`${url} returned no post`);
    } catch (err) {
      console.error(`${url} failed:`, err.message);
    }
  }
  return null;
}

function fromFx(data) {
  const t = data?.tweet ?? data;
  if (!t?.id || !t.author) return null;
  const media = t.media || {};
  const facets = t.raw_text?.facets || [];
  // Older posts keep the t.co link to their own media in the text.
  let text = t.text || "";
  for (const f of facets) {
    if (f.type === "media" && f.original) text = text.replace(f.original, "");
  }
  return {
    url: t.url || `https://x.com/i/status/${t.id}`,
    name: t.author.name || t.author.screen_name,
    handle: t.author.screen_name,
    avatar: t.author.avatar_url || null,
    text: text.trim(),
    timestamp: t.created_timestamp || null,
    links: facets
      .filter((f) => f.type === "url" && f.replacement)
      .map((f) => f.replacement),
    photos: (media.photos || []).map((p) => ({
      url: p.url,
      alt: p.altText || null,
    })),
    videos: (media.videos || []).map((v) => ({
      url: v.url,
      thumbnail: v.thumbnail_url || null,
    })),
    quote: t.quote ? fromFx(t.quote) : null,
  };
}

function fromVx(t) {
  if (!t?.tweetID || !t.user_screen_name) return null;
  const media = t.media_extended || [];
  const text = t.text || "";
  return {
    url: `https://x.com/${t.user_screen_name}/status/${t.tweetID}`,
    name: t.user_name || t.user_screen_name,
    handle: t.user_screen_name,
    avatar: t.user_profile_image_url || null,
    text,
    timestamp: t.date_epoch || null,
    // vxTwitter has no link entities, but it expands t.co links in the text.
    links: [...text.matchAll(/https?:\/\/[^\s<>]+/g)].map((m) => trimUrl(m[0])),
    photos: media
      .filter((m) => m.type === "image")
      .map((m) => ({ url: m.url, alt: m.altText || null })),
    videos: media
      .filter((m) => m.type === "video" || m.type === "gif")
      .map((m) => ({ url: m.url, thumbnail: m.thumbnail_url || null })),
    quote: t.qrt ? fromVx(t.qrt) : null,
  };
}

// Drops sentence punctuation stuck to the end of a URL found in text, keeping
// a closing bracket only when the URL also has the matching opening one.
function trimUrl(url) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  for (;;) {
    const last = url.at(-1);
    if (".,;:!?'\"".includes(last)) {
      url = url.slice(0, -1);
    } else if (pairs[last]) {
      const opens = url.split(pairs[last]).length - 1;
      const closes = url.split(last).length - 1;
      if (closes <= opens) return url;
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

// Slack mrkdwn needs &, <, > escaped. Anything else is left alone so bare
// URLs in the text still autolink.
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Truncates already-escaped mrkdwn without leaving half an entity at the end.
function clamp(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).replace(/&[a-z]*$/, "") + "…";
}

function linkText(url, label) {
  return `<${url.replace(/\|/g, "%7C")}|${esc(label)}>`;
}

function byline(t) {
  return `*${esc(t.name)}* ${linkText(`https://x.com/${t.handle}`, `@${t.handle}`)}`;
}

function mediaBlocks(t) {
  const blocks = [];
  for (const [i, p] of t.photos.entries()) {
    blocks.push({
      type: "image",
      image_url: p.url,
      alt_text: truncate(p.alt || `Image ${i + 1} from @${t.handle}`, 2000),
    });
  }
  for (const [i, v] of t.videos.entries()) {
    const label = t.videos.length > 1 ? `Play video ${i + 1}` : "Play video";
    const section = {
      type: "section",
      text: { type: "mrkdwn", text: `:arrow_forward: ${linkText(v.url, label)}` },
    };
    if (v.thumbnail) {
      section.accessory = {
        type: "image",
        image_url: v.thumbnail,
        alt_text: `Video thumbnail from @${t.handle}`,
      };
    }
    blocks.push(section);
  }
  return blocks;
}

// Builds { text, blocks } for chat.postMessage. `text` is the notification
// and screen reader fallback.
export function buildMessage(t) {
  const blocks = [];

  const header = [];
  if (t.avatar) {
    header.push({ type: "image", image_url: t.avatar, alt_text: `@${t.handle}` });
  }
  header.push({ type: "mrkdwn", text: byline(t) });
  blocks.push({ type: "context", elements: header });

  if (t.text) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: clamp(esc(t.text), MAX_TEXT) },
    });
  }

  blocks.push(...mediaBlocks(t));

  if (t.quote) {
    const q = t.quote;
    const head = `Quoting ${byline(q)}\n`;
    const tail = `\n${linkText(q.url, "View quoted post")}`;
    const quoted = q.text
      ? clamp(esc(q.text).replace(/^/gm, "> "), MAX_TEXT - head.length - tail.length)
      : "";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: head + quoted + tail },
    });
    blocks.push(...mediaBlocks(q));
  }

  // Add whole links until the line is full so a <url|label> is never cut.
  let linkLine = "";
  for (const l of new Set([...t.links, ...(t.quote?.links || [])])) {
    const next = `${linkLine ? linkLine + "  " : "Links: "}${linkText(l, truncate(l, 80))}`;
    if (next.length > MAX_TEXT) break;
    linkLine = next;
  }
  if (linkLine) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: linkLine }],
    });
  }

  const footer = [linkText(t.url, "View on X")];
  if (t.timestamp) {
    footer.push(
      `<!date^${t.timestamp}^{date_short_pretty} at {time}|${new Date(
        t.timestamp * 1000
      ).toUTCString()}>`
    );
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: footer.join(" · ") }],
  });

  return {
    // Escaped so a post can't smuggle <!channel> or <@user> into the plain
    // text retry, where Slack would treat it as live syntax.
    text: `${clamp(esc(`@${t.handle}: ${t.text}`), MAX_TEXT)}\n${t.url}`,
    blocks,
  };
}

// Plain text reply for a post that none of the sources could load.
export function buildFallback(id) {
  return {
    text: `Couldn't load https://x.com/i/status/${id}. Try https://fixupx.com/i/status/${id}`,
  };
}
