// Vercel Serverless Function: /api/oembed
// Reads the text of a public Instagram or Facebook post server-side so the
// browser never talks to graph.facebook.com directly (avoiding the CORS
// block) and so a shared access token, if you set one, never reaches the
// client.
//
// Deploy this file at api/oembed.js in your project root — Vercel picks it
// up automatically, no extra config needed.
//
// Since 15 June 2026 Meta's oEmbed endpoints (Instagram, Facebook posts,
// Facebook videos) work without an access token and without App Review, for
// public content only. Optional: set META_ACCESS_TOKEN in your Vercel
// project's Environment Variables (Settings → Environment Variables) as
// "app-id|client-token" to raise the rate limit. Posts that can't be read
// (private, friends-only, deleted) return an empty description so the app
// can fall back to asking the user to paste the caption.

function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

function extractMetaContent(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`, "i"),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return match[1];
  }
  return null;
}

// Instagram's og:description is usually wrapped like:
// "1,234 Likes, 56 Comments - username on Instagram: "the actual caption""
// Pull just the quoted part out when that wrapper is present.
function parseCaption(rawDescription) {
  const wrapped = rawDescription.match(/:\s*"([\s\S]*)"\s*$/);
  return wrapped ? wrapped[1] : rawDescription;
}

// Fetch a post page the way Meta's own link-preview crawler does and read
// its og:description. Returns the decoded text, or null when the page can't
// be read (login wall, not found, no description).
async function fetchOgDescription(postUrl) {
  try {
    const pageRes = await fetch(postUrl, {
      headers: {
        // Identify honestly as a link-preview crawler — the same identity
        // Meta explicitly supports for generating link previews (Slack,
        // iMessage, Facebook itself all use this), rather than spoofing a
        // real browser.
        "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      },
    });
    if (!pageRes.ok) return null;
    const html = await pageRes.text();
    const raw = extractMetaContent(html, "og:description");
    if (!raw) return null;
    const decoded = decodeHtmlEntities(raw).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

async function fetchInstagramCaption(postUrl) {
  const raw = await fetchOgDescription(postUrl);
  if (!raw) return null;
  const caption = parseCaption(raw).trim();
  return caption || null;
}

// Facebook's oEmbed response carries the post as embed HTML: a blockquote
// holding the post text, the author, and the date. Reduce it to plain text.
function htmlToText(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|blockquote|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// fb.watch links are shorteners — resolve one to the canonical post URL
// before handing it to oEmbed, which doesn't always accept the short form.
async function resolveShortLink(shortUrl) {
  try {
    const pageRes = await fetch(shortUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      },
    });
    return pageRes.url || shortUrl;
  } catch {
    return shortUrl;
  }
}

// Try Meta's Facebook oEmbed endpoints (post, then video — or the reverse
// for URLs that look like videos). Returns the parsed response, or null
// when neither endpoint will serve the post (private, deleted, ...).
async function fetchFacebookEmbed(postUrl, token) {
  let pathname = "";
  try {
    pathname = new URL(postUrl).pathname;
  } catch {
    return null;
  }
  const looksLikeVideo = /\/(videos|reel|reels|watch)\b/.test(pathname);
  const endpoints = looksLikeVideo ? ["oembed_video", "oembed_post"] : ["oembed_post", "oembed_video"];
  for (const endpoint of endpoints) {
    try {
      let apiUrl = `https://graph.facebook.com/v25.0/${endpoint}?url=${encodeURIComponent(postUrl)}&omitscript=true`;
      if (token) {
        apiUrl += `&access_token=${encodeURIComponent(token)}`;
      }
      const metaRes = await fetch(apiUrl);
      if (!metaRes.ok) continue;
      const data = await metaRes.json();
      if (data && typeof data.html === "string" && data.html) return data;
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

export default async function handler(req, res) {
  // Allow the frontend (same origin in production, any origin while you're
  // testing locally or from a Claude artifact preview) to call this.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { url, access_token } = req.query;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing required 'url' query parameter." });
    return;
  }

  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^(www\.|m\.)/, "");
  } catch {
    res.status(400).json({ error: "'url' is not a valid URL." });
    return;
  }
  const isInstagram = hostname === "instagram.com";
  const isFacebook = hostname === "facebook.com" || hostname === "fb.watch";
  if (!isInstagram && !isFacebook) {
    res.status(400).json({ error: "Only instagram.com and facebook.com URLs are accepted." });
    return;
  }

  const token = (typeof access_token === "string" && access_token.trim()) || process.env.META_ACCESS_TOKEN;

  if (isFacebook) {
    const targetUrl = hostname === "fb.watch" ? await resolveShortLink(url) : url;
    const data = await fetchFacebookEmbed(targetUrl, token);
    let text = data ? htmlToText(data.html) : "";
    if (!text) {
      // Secondary route: some public Page posts expose their text as the
      // page's og:description even when oEmbed won't serve them. Only trust
      // it when the URL still points at a specific post or video — a short
      // link that resolved to a generic hub page would otherwise hand back
      // Facebook's own site description.
      let looksLikePost = false;
      try {
        const u = new URL(targetUrl);
        looksLikePost =
          /\/(posts|videos|reel|reels)\/[^/]+/.test(u.pathname) || /[?&](story_fbid|v)=[^&]+/.test(u.search);
      } catch {
        looksLikePost = false;
      }
      if (looksLikePost) {
        text = (await fetchOgDescription(targetUrl)) || "";
      }
    }
    // An unreadable post is not an error for the app: an empty description
    // sends the user to the paste-the-caption fallback, same as a post
    // whose caption Instagram wouldn't share.
    res.status(200).json({
      description: text.slice(0, 4000),
      title: data?.author_name || "",
      author_name: data?.author_name || "",
    });
    return;
  }

  let endpoint = `https://graph.facebook.com/v25.0/instagram_oembed?url=${encodeURIComponent(url)}&omitscript=true`;
  if (token) {
    endpoint += `&access_token=${encodeURIComponent(token)}`;
  }

  try {
    const metaRes = await fetch(endpoint);
    const data = await metaRes.json();
    if (!metaRes.ok) {
      res.status(metaRes.status).json(data);
      return;
    }
    const caption = await fetchInstagramCaption(url);
    if (caption) data.description = caption;
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: "Couldn't reach Meta's oEmbed endpoint.", detail: err?.message });
  }
}
