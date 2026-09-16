// Vercel Serverless Function: /api/oembed
// Proxies Instagram oEmbed requests server-side so the browser never talks
// to graph.facebook.com directly (avoiding the CORS block) and so a shared
// access token, if you set one, never reaches the client.
//
// Deploy this file at api/oembed.js in your project root — Vercel picks it
// up automatically, no extra config needed.
//
// Optional: set META_ACCESS_TOKEN in your Vercel project's Environment
// Variables (Settings → Environment Variables) as "app-id|client-token" to
// raise your rate limit from 1,000/hr (tokenless) to 5M/day. Only needed
// once you're past the tokenless limit and have App Review approval.

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

async function fetchCaption(postUrl) {
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
    const decoded = decodeHtmlEntities(raw);
    const caption = parseCaption(decoded).trim();
    return caption || null;
  } catch {
    return null;
  }
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
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    res.status(400).json({ error: "'url' is not a valid URL." });
    return;
  }
  if (hostname !== "instagram.com") {
    res.status(400).json({ error: "Only instagram.com URLs are accepted." });
    return;
  }

  const token = (typeof access_token === "string" && access_token.trim()) || process.env.META_ACCESS_TOKEN;

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
    const caption = await fetchCaption(url);
    if (caption) data.description = caption;
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: "Couldn't reach Meta's oEmbed endpoint.", detail: err?.message });
  }
}
