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
    res.status(metaRes.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Couldn't reach Meta's oEmbed endpoint.", detail: err?.message });
  }
}
