// Vercel Serverless Function: /api/quick
// The fast first tier of a Fact Jury check. A full Sonnet verdict takes
// ~30 seconds; this endpoint answers in a few seconds with a PRELIMINARY
// take from a small, fast model (Haiku) doing a light scan (web search
// capped at 2 uses): just the score/verdict and a one-sentence summary.
// The browser calls /api/quick and /api/research in parallel, shows this
// as a preliminary card the moment it lands, then replaces it with the
// full findings — the full result always wins if they differ.
//
// Quota: a quick + full pair counts as ONE check. This endpoint never
// increments the daily counter — it only peeks (refusing when the visitor
// is already at the limit) — and the paired /api/research call performs
// the single real increment and writes the single usage-log event.
// This endpoint also never writes to the verdict cache: if a full result
// is already cached, the preliminary answer is derived from it instead of
// spending a model call.

import {
  DAILY_LIMIT,
  stripFences,
  getClientIp,
  peekDailyCount,
  readCachedVerdict,
  callAnthropic,
  friendlyApiError,
  isOwnerRequest,
} from "./_shared.js";

const QUICK_VERDICT_TOOL = {
  name: "submit_quick_verdict",
  description: "Submit the fast preliminary purchase verdict. Call this exactly once, as your last action.",
  input_schema: {
    type: "object",
    properties: {
      verdict_label: { type: "string", enum: ["Great Buy", "Decent", "Skip It", "Avoid"] },
      worth_it_score: {
        type: "number",
        description: "0 to 10, anchored: 9-10 excellent, 7-8 good, 5-6 genuinely mixed, 3-4 weak, 0-2 nothing verifiable to recommend. Must agree with verdict_label: Great Buy 7-10, Decent 5-6, Skip It 0-4, Avoid 0-2. If you find virtually no independent reviews, ratings, or third-party coverage, the score cannot exceed 2.",
      },
      one_sentence_summary: {
        type: "string",
        description: "Exactly one sentence of at most 24 words that a shopper can act on — the headline reason for the score.",
      },
    },
    required: ["verdict_label", "worth_it_score", "one_sentence_summary"],
  },
};

const QUICK_FACTCHECK_TOOL = {
  name: "submit_quick_factcheck",
  description: "Submit the fast preliminary fact-check rating. Call this exactly once, as your last action.",
  input_schema: {
    type: "object",
    properties: {
      rating: {
        type: "string",
        enum: ["True", "Mostly True", "Mixed", "Misleading", "False", "Can't Verify"],
        description: "True = accurate with no important context missing. Mostly True = right in substance, minor details off. Mixed = part accurate, part not. Misleading = built on a real fact but framed so a reasonable person takes away something untrue. False = contradicted by the evidence. Can't Verify = no reliable evidence either way, or opinion/prediction rather than a checkable fact.",
      },
      one_sentence_summary: {
        type: "string",
        description: "Exactly one sentence of at most 24 words stating what the evidence shows about the claim.",
      },
    },
    required: ["rating", "one_sentence_summary"],
  },
};

// The preliminary answer for a check whose full verdict is already cached:
// pull the score/label out of the cached result and trim its summary to
// its first sentence. No model call, no quota, instant.
function quickFromCached(cached, isFactCheck) {
  if (!cached || typeof cached !== "object") return null;
  const summary = typeof cached.summary === "string" ? cached.summary.trim() : "";
  const firstSentence = (summary.match(/^.*?[.!?](?=\s|$)/)?.[0] || summary).trim();
  if (!firstSentence) return null;
  if (isFactCheck) {
    if (!cached.rating) return null;
    return { rating: cached.rating, one_sentence_summary: firstSentence, preliminary: true, from_cache: true };
  }
  if (!cached.verdict_label || typeof cached.worth_it_score !== "number") return null;
  return {
    verdict_label: cached.verdict_label,
    worth_it_score: cached.worth_it_score,
    one_sentence_summary: firstSentence,
    preliminary: true,
    from_cache: true,
  };
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

  // Same inputs and validation as /api/research.
  const { caption, query, mode, link } = req.body || {};
  const isFactCheck = mode === "factcheck";
  const hasCaption = typeof caption === "string" && caption.trim().length > 0;
  const hasQuery = typeof query === "string" && query.trim().length > 0;
  if (!hasCaption && !hasQuery) {
    res.status(400).json({ error: "Missing 'caption' or 'query' in request body." });
    return;
  }
  if (!hasCaption && query.trim().length > (isFactCheck ? 500 : 120)) {
    res.status(400).json({ error: "That text is too long for a quick check." });
    return;
  }

  const ip = getClientIp(req);

  // Cache first, same as /api/research: derive the preliminary answer
  // from the stored full verdict instead of calling the model. Uses the
  // same alias-aware lookup as /api/research, so a repeat the full
  // endpoint would serve from cache never gets a fresh preliminary
  // model call here either.
  const cached = await readCachedVerdict(isFactCheck, caption, query, link);
  if (cached) {
    const derived = quickFromCached(cached, isFactCheck);
    if (derived) {
      res.status(200).json(derived);
      return;
    }
    // A cached result we can't derive from (unexpected shape) — fall
    // through to the model rather than failing the preliminary card.
  }

  // Peek only — never increment. If the visitor is already at today's
  // limit, the paired /api/research call is about to 429 anyway; answer
  // the same way here so no preliminary card flashes up first.
  const usedToday = await peekDailyCount(ip);
  if (!isOwnerRequest(req) && usedToday >= DAILY_LIMIT) {
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
    tool = QUICK_FACTCHECK_TOOL;
    toolName = "submit_quick_factcheck";
    subject = hasCaption
      ? `Below is the text of a social media post (Instagram or Facebook) making a claim a reader wants checked. The claim may be stated outright or clearly implied — check the claim the post is really making.

CAPTION:
"""
${caption.trim()}
"""`
      : `A user heard or read the following claim and wants to know whether it's true.

CLAIM:
"""
${query.trim()}
"""`;

    prompt = `You are a fact-checker giving a FAST preliminary rating. ${subject}

1. Identify the single most important factual claim — the one a reasonable reader would take away.
2. Do a quick scan (at most a couple of searches) of what reliable sources say: primary sources and official records first, then reputable reporting and, for health or science claims, the mainstream medical/scientific consensus. Ignore the claimant's own posts and unsourced social posts.
3. Rate the claim on the standard scale and give exactly ONE sentence on what the evidence shows. This is a preliminary take — a fuller check follows — so if the quick scan is thin, "Can't Verify" is an honest answer. Judge the claim, never the person making it.

Call the submit_quick_factcheck tool exactly once with your rating. Do not write your answer as plain text — use the tool.`;
  } else {
    tool = QUICK_VERDICT_TOOL;
    toolName = "submit_quick_verdict";
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

If the name is ambiguous, pick the most likely consumer product or brand.`;

    prompt = `You are a consumer product research analyst giving a FAST preliminary verdict. ${subject}

1. Identify the specific product, brand, or service in question.
2. Do a quick scan (at most a couple of searches) of independent reviews, user ratings, common complaints, and any trust/scam red flags. Prioritize sources that are not the brand's own marketing.
3. Give your preliminary worth-it score (0-10), verdict label, and exactly ONE sentence a shopper can act on — the headline reason for the score. Anchor the score: 9-10 excellent, 7-8 good, 5-6 genuinely mixed, 3-4 weak, 0-2 nothing verifiable to recommend. If you find virtually no independent reviews, ratings, or third-party coverage of the brand, the score cannot exceed 2 — no evidence is a failing grade, not a neutral one, and likes or follower counts never raise a score. This is a preliminary take; a fuller review follows.

Call the submit_quick_verdict tool exactly once with your verdict. Do not write your answer as plain text — use the tool.`;
  }

  try {
    const { ok, status, data } = await callAnthropic(
      apiKey,
      {
        model: "claude-haiku-4-5",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }, tool],
      },
      { timeoutMs: 30000 }
    );
    if (!ok) {
      res.status(status === 429 || status === 529 ? 503 : 502).json({ error: friendlyApiError(status) });
      return;
    }

    const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === toolName);
    if (toolUse) {
      res.status(200).json({ ...toolUse.input, preliminary: true });
      return;
    }

    // Same plain-text fallback as /api/research, for the rare case the
    // model answered in prose instead of calling the tool.
    const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
    const joined = textBlocks.join("\n").trim();
    if (joined) {
      try {
        const parsed = JSON.parse(stripFences(joined));
        res.status(200).json({ ...parsed, preliminary: true });
        return;
      } catch {
        const match = joined.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const parsedMatch = JSON.parse(match[0]);
            res.status(200).json({ ...parsedMatch, preliminary: true });
            return;
          } catch {
            // fall through to the error below
          }
        }
      }
    }
    res.status(502).json({ error: "The model didn't submit a quick verdict. Try again." });
  } catch (err) {
    res.status(502).json({ error: "The quick check hit a snag — the full verdict is still on its way." });
  }
}
