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

import { createHash } from "node:crypto";

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

// --- Result cache -------------------------------------------------------
// A finished verdict is stored in the same Upstash database and served
// back for repeat checks of the same product or claim (7 days). Repeat
// lookups are common — popular products, and every visitor who taps the
// same "worth comparing to" alternative — and a cached answer returns in
// milliseconds instead of re-running the whole research pipeline. Cache
// hits do not consume the visitor's daily quota. Everything fails open:
// if the cache is unreachable, the request just runs the research as
// before.

const CACHE_TTL_SECONDS = 604800; // 7 days

function getUpstashConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

function normalizeLink(link) {
  try {
    const u = new URL(link.trim());
    const host = u.hostname.replace(/^(www\.|m\.)/, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return link.trim().toLowerCase();
  }
}

// The cache key decides what counts as "the same check". A check that came
// from a post link is keyed on the link itself: the link never changes,
// while the caption text fetched from the post can come back worded
// slightly differently between visits (wrapper lines, line breaks), which
// used to make every repeat of the same ad miss the cache. Typed checks
// key on the normalized text.
function cacheKeyFor(isFactCheck, caption, query, link) {
  let basis;
  if (typeof link === "string" && link.trim()) {
    basis = `link:${normalizeLink(link)}`;
  } else if (typeof caption === "string" && caption.trim()) {
    const text = caption
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase()
      // Belt-and-braces: drop an Instagram engagement wrapper if one ever
      // reaches the key ("12,345 Likes, 678 Comments - user on Instagram: \"…\"")
      .replace(/^[\d,.]+\s+likes?,\s*[\d,.]+\s+comments?\s+-\s+.*?on instagram:\s*"/, "")
      .replace(/"$/, "");
    basis = `caption:${text}`;
  } else {
    basis = `query:${(query || "").trim().toLowerCase().replace(/\s+/g, " ")}`;
  }
  const digest = createHash("sha256").update(basis).digest("hex").slice(0, 32);
  return `verdict-cache:v2:${isFactCheck ? "factcheck" : "product"}:${digest}`;
}

async function readCache(key) {
  const cfg = getUpstashConfig();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    const data = await r.json();
    if (typeof data?.result === "string" && data.result) {
      return JSON.parse(data.result);
    }
  } catch {
    // best-effort — a cache failure just means the research runs
  }
  return null;
}

async function writeCache(key, value) {
  const cfg = getUpstashConfig();
  if (!cfg) return;
  try {
    await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", key, JSON.stringify(value), "EX", String(CACHE_TTL_SECONDS)]),
    });
  } catch {
    // best-effort — a failed write only costs the next visitor a re-run
  }
}

async function logUsage(ip, isFactCheck, subjectText, cached, resultLabel) {
  const cfg = getUpstashConfig();
  if (!cfg) return;
  try {
    const event = JSON.stringify({
      t: new Date().toISOString(),
      ip: createHash("sha256").update(ip || "unknown").digest("hex").slice(0, 10),
      mode: isFactCheck ? "factcheck" : "product",
      subject: (subjectText || "").replace(/\s+/g, " ").slice(0, 120),
      cached: !!cached,
      result: resultLabel || null,
    });
    const post = (cmd) =>
      fetch(cfg.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(cmd),
      });
    await post(["LPUSH", "usage-events", event]);
    await post(["LTRIM", "usage-events", "0", "199"]);
  } catch {
    // best-effort — usage logging must never block a verdict
  }
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
            url: {
              type: "string",
              description: "A real link from your research for this alternative — its official product page or a credible independent review/comparison of it. Never invent a URL; if you have no real link for an alternative, leave that alternative out.",
            },
          },
          required: ["name", "reason", "url"],
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

const FACTCHECK_TOOL = {
  name: "submit_factcheck",
  description: "Submit the final structured fact-check once research is complete. Call this exactly once, as your last action.",
  input_schema: {
    type: "object",
    properties: {
      claim: { type: "string", description: "The factual claim being checked, stated in one clear sentence." },
      rating: {
        type: "string",
        enum: ["True", "Mostly True", "Mixed", "Misleading", "False", "Can't Verify"],
        description: "True = accurate with no important context missing. Mostly True = right in substance, minor details off. Mixed = part accurate, part not. Misleading = built on a real fact but framed so a reasonable person takes away something untrue. False = contradicted by the evidence. Can't Verify = no reliable evidence either way, or the statement is opinion/prediction rather than a checkable fact.",
      },
      summary: {
        type: "string",
        description: "2-4 sentences explaining the rating in plain language, including any important context the claim leaves out.",
      },
      evidence: {
        type: "array",
        description: "2 to 5 short bullet points: the key facts the rating rests on.",
        items: { type: "string" },
      },
      sources: {
        type: "array",
        description: "At least 3 sources when available.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            note: { type: "string", description: "A few words on what this source shows, e.g. 'CDC data on vitamin D supplementation trials'." },
          },
          required: ["title", "url", "note"],
        },
      },
    },
    required: ["claim", "rating", "summary", "evidence", "sources"],
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

  // Two ways in: the caption text of an Instagram post, or text typed
  // straight into the search bar (a brand/product name in product mode,
  // a claim in fact-check mode). `mode` selects which kind of research
  // runs; anything other than "factcheck" is treated as product mode, so
  // older clients keep working.
  const { caption, query, mode, link } = req.body || {};
  const isFactCheck = mode === "factcheck";
  const hasCaption = typeof caption === "string" && caption.trim().length > 0;
  const hasQuery = typeof query === "string" && query.trim().length > 0;
  if (!hasCaption && !hasQuery) {
    res.status(400).json({ error: "Missing 'caption' or 'query' in request body." });
    return;
  }
  if (!hasCaption && query.trim().length > (isFactCheck ? 500 : 120)) {
    res.status(400).json({
      error: isFactCheck
        ? "That claim is too long — state it in a sentence or two."
        : "That name is too long — keep it to a brand or product name.",
    });
    return;
  }

  const ip = getClientIp(req);

  // Cache first: a repeat check of the same product or claim is served
  // from the stored verdict — no daily quota consumed, no research re-run.
  const cacheKey = cacheKeyFor(isFactCheck, caption, query, link);
  const cached = await readCache(cacheKey);
  if (cached) {
    await logUsage(ip, isFactCheck, hasCaption ? caption : query, true, cached.verdict_label || cached.rating);
    res.status(200).json(cached);
    return;
  }

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

  let subject;
  let prompt;
  let tool;
  let toolName;

  if (isFactCheck) {
    tool = FACTCHECK_TOOL;
    toolName = "submit_factcheck";
    subject = hasCaption
      ? `Below is the text of a social media post (Instagram or Facebook). The poster is making a claim, and a reader wants to know whether it's true. The claim may be stated outright in the text or clearly implied by it — check the claim the post is really making.

CAPTION:
"""
${caption.trim()}
"""`
      : `A user heard or read the following claim and wants to know whether it's true.

CLAIM:
"""
${query.trim()}
"""`;

    prompt = `You are a fact-checker. ${subject}

1. Identify the single most important factual claim being made — the one a reasonable reader would take away. Claims can be about anything: a news event, a health or science statement, a statistic, something a public figure supposedly did or said. If the text makes several claims, check the central one and state it exactly in the claim field.
2. Search the web for what reliable sources say: primary sources and official records first, then reputable news outlets, and for health or science claims the mainstream scientific/medical consensus (major medical institutions, peer-reviewed findings). Do not treat the claimant's own posts, content farms, or unsourced social posts as evidence.
3. Weigh the evidence and rate the claim:
   - True: accurate, with no important context missing.
   - Mostly True: accurate in substance, minor details off or slightly overstated.
   - Mixed: part accurate, part not — or the evidence genuinely cuts both ways.
   - Misleading: built on a real fact but framed so a reasonable person takes away something untrue (missing context, cherry-picked numbers, old footage presented as current, and similar).
   - False: contradicted by the evidence.
   - Can't Verify: no reliable evidence either way, or the statement is opinion or prediction rather than a checkable fact — say which in the summary.
4. Judge the claim, never the person making it. Stick to what the evidence shows; where sources disagree, say so in the evidence.

Once your research is complete, call the submit_factcheck tool exactly once with your final findings. Do not write your answer as plain text — use the tool.`;
  } else {
    tool = VERDICT_TOOL;
    toolName = "submit_verdict";
    subject = hasCaption
      ? `Below is the text of a social media post (Instagram or Facebook) advertising a product or service.

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

    prompt = `You are a consumer product research analyst. ${subject}

1. Identify the specific product, brand, or service in question.
2. Search the web for independent reviews, user ratings, common complaints, and any trust/scam red flags. Prioritize sources that are not the brand's own marketing.
3. Also research whether there are well-regarded competing products or brands in the same category, and whether independent reviews suggest they're better value or better quality. For each alternative you name, include a real link from your research — its official product page or a credible independent review of it — never an invented URL.
4. Weigh all of this into an overall purchase verdict. This is about whether the product is actually worth buying and how it compares to alternatives — not only whether it's a scam.

Once your research is complete, call the submit_verdict tool exactly once with your final findings. Do not write your answer as plain text — use the tool.`;
  }

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
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, tool],
      }),
    });
    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      res.status(anthropicRes.status).json({ error: data?.error?.message || "Anthropic API request failed." });
      return;
    }

    const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === toolName);
    if (toolUse) {
      await writeCache(cacheKey, toolUse.input);
      await logUsage(ip, isFactCheck, hasCaption ? caption : query, false, toolUse.input.verdict_label || toolUse.input.rating);
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
      const parsedText = JSON.parse(stripFences(joined));
      await writeCache(cacheKey, parsedText);
      await logUsage(ip, isFactCheck, hasCaption ? caption : query, false, parsedText.verdict_label || parsedText.rating);
      res.status(200).json(parsedText);
      return;
    } catch {
      const match = joined.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsedMatch = JSON.parse(match[0]);
          await writeCache(cacheKey, parsedMatch);
          await logUsage(ip, isFactCheck, hasCaption ? caption : query, false, parsedMatch.verdict_label || parsedMatch.rating);
          res.status(200).json(parsedMatch);
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
