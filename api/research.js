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
//
// Optional but recommended: connect a free Upstash Redis database through
// your Vercel project's Storage tab. Vercel names the resulting env vars
// KV_REST_API_URL and KV_REST_API_TOKEN (it also accepts the raw Upstash
// names UPSTASH_REDIS_REST_URL/TOKEN, in case you set those manually) to
// cap each visitor at DAILY_LIMIT researches per day. Without either pair
// set, rate limiting is skipped entirely (the app still works, just
// unprotected against abuse).

const DAILY_LIMIT = 5;

function stripFences(text) {
  return text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

// Best-effort identification of the visitor by IP address. There's no
// login here, so this is a speed bump against abuse, not a hard identity
// check — people on the same network share a count, and it resets if
// someone switches networks. That's an accepted tradeoff for a free,
// no-login app.
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

// Talks to Upstash Redis over its REST API (no extra npm package needed).
// Returns { limited: true } and skips enforcement entirely if the two env
// vars aren't set, so the app still works before you finish setting up
// the rate limiter.
async function checkAndIncrementDailyCount(ip) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return { enforced: false, allowed: true, count: 0 };
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  const key = `research-count:${ip}:${today}`;

  const incrRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const incrData = await incrRes.json();
  const count = incrData?.result;

  if (count === 1) {
    // First request today for this IP — set the key to expire in ~26
    // hours so it cleans itself up without needing exact midnight math.
    await fetch(`${url}/expire/${encodeURIComponent(key)}/93600`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  return { enforced: true, allowed: typeof count === "number" && count <= DAILY_LIMIT, count };
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

  const ip = getClientIp(req);
  let rateLimit;
  try {
    rateLimit = await checkAndIncrementDailyCount(ip);
  } catch (err) {
    // If the rate limiter itself fails (e.g. Upstash is briefly down),
    // fail open rather than blocking every user's research.
    rateLimit = { enforced: false, allowed: true, count: 0 };
  }
  if (!rateLimit.allowed) {
    res.status(429).json({
      error: `You've used all ${DAILY_LIMIT} free researches for today. Try again tomorrow.`,
      dailyLimit: DAILY_LIMIT,
    });
    return;
  }

  // Two ways in: the caption text of an Instagram post, or a brand/product
  // name typed straight into the search bar.
  const { caption, query } = req.body || {};
  const hasCaption = typeof caption === "string" && caption.trim().length > 0;
  const hasQuery = typeof query === "string" && query.trim().length > 0;
  if (!hasCaption && !hasQuery) {
    res.status(400).json({ error: "Missing 'caption' or 'query' in request body." });
    return;
  }
  if (!hasCaption && query.trim().length > 120) {
    res.status(400).json({ error: "That name is too long — keep it to a brand or product name." });
    return;
  }

  const subject = hasCaption
    ? `Below is the caption text from an Instagram post advertising a product or service.

CAPTION:
"""
${caption.trim()}
"""`
    : `A shopper typed in the name of a brand, product, or service and wants to know whether it is worth buying.

NAME:
"""
${query.trim()}
"""

If the name is ambiguous, pick the most likely consumer product or brand and say which one you assumed in the summary.`;

  const prompt = `You are a consumer product research analyst. ${subject}

1. Identify the specific product, brand, or service in question.
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
