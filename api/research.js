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

const VERDICT_TOOL = {
  name: "submit_verdict",
  description: "Submit the final structured purchase verdict once research is complete. Call this exactly once, as your last action.",
  input_schema: {
    type: "object",
    properties: {
      product_name: { type: "string", description: "The specific product, brand, or service identified." },
      verdict_label: { type: "string", enum: ["Great Buy", "Decent", "Skip It", "Avoid"] },
      worth_it_score: {
        type: "number",
        description: "0 to 10. 10 = excellent purchase, highly recommended. 0 = terrible, avoid entirely.",
      },
      summary: {
        type: "string",
        description: "2-4 sentences explaining the reasoning in plain language, covering both quality/value and any trust concerns.",
      },
      alternatives: {
        type: "array",
        description: "0 to 3 named competing products/brands, ONLY when independent research clearly suggests they're a better value or better reviewed. Leave empty if nothing clearly stands out.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            reason: { type: "string" },
          },
          required: ["name", "reason"],
        },
      },
      sources: {
        type: "array",
        description: "At least 3 sources when available.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            note: { type: "string", description: "A few words on what this source shows, e.g. '4.8-star average across 2,000 reviews'." },
          },
          required: ["title", "url", "note"],
        },
      },
    },
    required: ["product_name", "verdict_label", "worth_it_score", "summary", "alternatives", "sources"],
  },
};

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

  const prompt = `You are a consumer product research analyst. Below is the caption text from an Instagram post advertising a product or service.

CAPTION:
"""
${caption.trim()}
"""

1. Identify the specific product, brand, or service being promoted.
2. Search the web for independent reviews, user ratings, common complaints, and any trust/scam red flags. Prioritize sources that are not the brand's own marketing.
3. Also research whether there are well-regarded competing products or brands in the same category, and whether independent reviews suggest they're better value or better quality.
4. Weigh all of this into an overall purchase verdict. This is about whether the product is actually worth buying and how it compares to alternatives — not only whether it's a scam.

Once your research is complete, call the submit_verdict tool exactly once with your final findings. Do not write your answer as plain text — use the tool.`;

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
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }, VERDICT_TOOL],
      }),
    });
    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      res.status(anthropicRes.status).json({ error: data?.error?.message || "Anthropic API request failed." });
      return;
    }

    const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "submit_verdict");
    if (toolUse) {
      res.status(200).json(toolUse.input);
      return;
    }

    // Fallback for the rare case the model answered in plain text instead of
    // calling the tool — try to recover a JSON object from it.
    const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
    const joined = textBlocks.join("\n").trim();
    if (!joined) {
      res.status(502).json({ error: "The model didn't submit a verdict. Try again." });
      return;
    }
    try {
      res.status(200).json(JSON.parse(stripFences(joined)));
      return;
    } catch {
      const match = joined.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          res.status(200).json(JSON.parse(match[0]));
          return;
        } catch {
          // fall through to the error below
        }
      }
      res.status(502).json({ error: "Couldn't parse the findings into a report. Try again." });
    }
  } catch (err) {
    res.status(502).json({ error: err?.message || "Research request failed." });
  }
}
