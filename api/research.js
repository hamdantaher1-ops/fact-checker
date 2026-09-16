// Vercel Serverless Function: /api/research
// Proxies the "research this product" call to Anthropic's Messages API
// server-side. The browser can't call api.anthropic.com directly outside
// Claude's own chat preview (no API key, and Anthropic doesn't allow
// anonymous cross-origin calls) — this function holds the real key and
// does the call on the server instead.
//
// Deploy this file at api/research.js in your project root.
//
// Required: set ANTHROPIC_API_KEY in your Vercel project's Environment
// Variables (Settings → Environment Variables), using a key from
// console.anthropic.com. Redeploy after adding it.

function stripFences(text) {
  return text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Add it in Vercel project settings and redeploy." });
    return;
  }

  const { caption } = req.body || {};
  if (!caption || typeof caption !== "string" || !caption.trim()) {
    res.status(400).json({ error: "Missing 'caption' in request body." });
    return;
  }

  const prompt = `You are a consumer-protection research analyst. Below is the caption text from an Instagram post advertising a product or service.

CAPTION:
"""
${caption.trim()}
"""

1. Identify the specific product, brand, or service being promoted.
2. Search the web for independent reviews, customer complaints, scam/fraud reports, chargeback or refund horror stories, and any relevant news coverage. Prioritize sources that are not the brand's own marketing.
3. Weigh what you find and reach a verdict.

Respond with ONLY a single JSON object, no markdown fences, no commentary before or after, matching exactly this shape:
{
  "product_name": string,
  "verdict": "good to buy" | "not recommended" | "likely scam",
  "risk_score": number between 0 and 10 (0 = very safe, 10 = almost certainly a scam),
  "summary": string, 2-4 sentences explaining the reasoning in plain language,
  "sources": [ { "title": string, "url": string, "note": string } ]
}
Include at least 3 sources when you can find them. "note" should say in a few words what each source shows (e.g. "BBB complaint about non-delivery").`;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      res.status(anthropicRes.status).json({ error: data?.error?.message || "Anthropic API request failed." });
      return;
    }

    const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
    const joined = textBlocks.join("\n").trim();
    if (!joined) {
      res.status(502).json({ error: "No answer came back from the model." });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(stripFences(joined));
    } catch {
      const match = joined.match(/\{[\s\S]*\}/);
      if (!match) {
        res.status(502).json({ error: "Couldn't parse the findings into a report." });
        return;
      }
      parsed = JSON.parse(match[0]);
    }

    res.status(200).json(parsed);
  } catch (err) {
    res.status(502).json({ error: err?.message || "Research request failed." });
  }
}
