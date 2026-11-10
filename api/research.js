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

import {
  DAILY_LIMIT,
  stripFences,
  getClientIp,
  checkAndIncrementDailyCount,
  cacheKeyFor,
  readCache,
  writeCache,
  logUsage,
  tagResultAlternatives,
  replaceDeadAmazonLinks,
  enrichAlternativeImages,
  callAnthropic,
  friendlyApiError,
  BUSY_MESSAGE,
  CAPACITY_MESSAGE,
  acquireResearchLock,
  releaseResearchLock,
  waitForCachedResult,
  checkGlobalDailyCap,
  isOwnerRequest,
} from "./_shared.js";

const VERDICT_TOOL = {
  name: "submit_verdict",
  description: "Submit the final structured purchase verdict once research is complete. Call this exactly once, as your last action.",
  input_schema: {
    type: "object",
    properties: {
      product_name: { type: "string", description: "The specific product, brand, or service identified." },
      url: {
        type: ["string", "null"],
        description: "A real link from your research to the maker's or store's own page for THIS product (NOT Amazon — the Amazon link goes in amazon_url). Prefer the product page where a shopper can buy it. Never invent a URL; null when no real link appeared in your research.",
      },
      amazon_url: {
        type: ["string", "null"],
        description: "The Amazon product page for THIS product, from one dedicated Amazon search (the product name together with amazon.com), in canonical form https://www.amazon.com/dp/<ASIN>. Only record a listing that appears available to buy — a price or buying options in what you saw. If the listing shows 'Currently unavailable', no price, or looks discontinued, set null — never guess one; the site adds its own Amazon search link in that case.",
      },
      verdict_label: { type: "string", enum: ["Great Buy", "Decent", "Skip It", "Avoid"] },
      worth_it_score: {
        type: "number",
        description: "0 to 10, anchored: 9-10 excellent, 7-8 good, 5-6 genuinely mixed, 3-4 weak, 0-2 nothing verifiable to recommend. Must agree with verdict_label: Great Buy 7-10, Decent 5-6, Skip It 0-4, Avoid 0-2. If research finds virtually no independent reviews, ratings, or third-party coverage, the score cannot exceed 2.",
      },
      summary: {
        type: "string",
        description: "The bottom line in plain language: at most 2 sentences and 32 words. Verdict first, the single strongest reason, and any serious trust concern. Do NOT repeat the pros and cons — they have their own section below.",
      },
      pros: {
        type: "array",
        description: "Up to 3 short bullet points FOR buying — concrete strengths backed by your research (review praise, ratings, value, guarantees). Each at most 10 words. Only real, sourced points; if there is genuinely nothing in its favour, return an empty array rather than inventing filler.",
        items: { type: "string" },
      },
      cons: {
        type: "array",
        description: "Up to 3 short bullet points AGAINST buying — concrete weaknesses from your research (recurring complaints, poor value, missing independent reviews/coverage, trust or scam red flags). Each at most 10 words. Only real, sourced points; if there is genuinely nothing against it, return an empty array rather than inventing filler.",
        items: { type: "string" },
      },
      alternatives: {
        type: "array",
        description: "0 to 3 named competing products/brands, ONLY when independent research clearly suggests they're a better value or better reviewed. Leave empty if nothing clearly stands out.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            reason: { type: "string", description: "One short reason this alternative is worth comparing, at most 10 words." },
            url: {
              type: "string",
              description: "A real link from your research to the maker's or store's own page for this alternative (NOT Amazon — the Amazon link goes in amazon_url). Prefer the product page where a shopper can buy it; a credible independent review is the fallback. Never invent a URL; if you have no real link for an alternative, leave that alternative out.",
            },
            amazon_url: {
              type: ["string", "null"],
              description: "The Amazon product page URL for this alternative, ONLY if an Amazon listing for it actually appeared in your research — run a dedicated search for the product on Amazon to look for one — and appears available to buy (a price or buying options in what you saw; a 'Currently unavailable' or discontinued-looking listing counts as NO listing). Use the canonical form https://www.amazon.com/dp/<ASIN>. Set null when no live Amazon listing appeared. Never construct, shorten, or guess an Amazon URL.",
            },
            price_text: {
              type: ["string", "null"],
              description: "The approximate price for this alternative exactly as seen in a source you actually read, formatted like '~$129' or '~£899'. If no price appeared in sources you actually read, set this to null. Never guess, round from memory, or invent a price.",
            },
            image_url: {
              type: ["string", "null"],
              description: "A product image URL you actually saw in your search results for this specific product. If you did not actually see an image URL for it, set this to null. Never construct or invent an image URL.",
            },
            blurb: {
              type: "string",
              description: "One short line (10 words max) on who this alternative suits best or its headline strength, e.g. 'Budget pick — nearly as good, half the price.'",
            },
            verdict_label: {
              type: ["string", "null"],
              enum: ["Great Buy", "Decent", "Skip It", "Avoid", null],
              description: "Your verdict for THIS alternative, rated with the same rubric as the main product from the research you did on it. Null only when your research found too little on it to rate honestly.",
            },
            worth_it_score: {
              type: ["number", "null"],
              description: "0-10 worth-it score for this alternative, agreeing with its verdict_label (Great Buy 7-10, Decent 5-6, Skip It 0-4, Avoid 0-2). Same hard rule as the main product: virtually no independent reviews, ratings, or coverage caps the score at 2. Null when verdict_label is null.",
            },
          },
          required: ["name", "reason", "url"],
        },
      },
      sources: {
        type: "array",
        description: "3 to 5 of the most useful sources when available. Do not pad the list.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            note: { type: "string", description: "At most 6 words on what this source shows, e.g. '4.8 stars across 2,000 reviews'." },
          },
          required: ["title", "url", "note"],
        },
      },
    },
    required: ["product_name", "verdict_label", "worth_it_score", "summary", "pros", "cons", "alternatives", "sources"],
  },
};

const FACTCHECK_TOOL = {
  name: "submit_factcheck",
  description: "Submit the final structured fact-check once research is complete. Call this exactly once, as your last action.",
  input_schema: {
    type: "object",
    properties: {
      claim: { type: "string", description: "The factual claim being checked, stated in one clear sentence of at most 24 words." },
      rating: {
        type: "string",
        enum: ["True", "Mostly True", "Mixed", "Misleading", "False", "Can't Verify"],
        description: "True = accurate with no important context missing. Mostly True = right in substance, minor details off. Mixed = part accurate, part not. Misleading = built on a real fact but framed so a reasonable person takes away something untrue. False = contradicted by the evidence. Can't Verify = no reliable evidence either way, or the statement is opinion/prediction rather than a checkable fact.",
      },
      summary: {
        type: "string",
        description: "Exactly 2 concise sentences, at most 40 words total: the rating first, then the decisive fact or missing context. Write it like the bottom line of a product verdict — no background that does not change the rating.",
      },
      evidence: {
        type: "array",
        description: "Exactly 3 short bullet points: only the facts the rating rests on. Each at most 14 words.",
        items: { type: "string" },
      },
      sources: {
        type: "array",
        description: "3 to 5 of the most useful sources when available. Do not pad the list.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            note: { type: "string", description: "At most 6 words on what this source shows, e.g. 'CDC vitamin D trial data'." },
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
    res.status(200).json(tagResultAlternatives(cached));
    return;
  }

  // Viral-spike dedupe: if another visitor is already researching this
  // exact check, wait for their result to land in the cache and share it
  // — no duplicate research run, and the shared result is free (followers
  // never touch the daily quota or the global cap).
  let holdingLock = await acquireResearchLock(cacheKey);
  if (!holdingLock) {
    const shared = await waitForCachedResult(cacheKey);
    if (shared) {
      await logUsage(ip, isFactCheck, hasCaption ? caption : query, true, shared.verdict_label || shared.rating);
      res.status(200).json(tagResultAlternatives(shared));
      return;
    }
    // The first researcher finished without a result (or stalled) — try
    // to take over as the researcher; if someone else already has, ask
    // the visitor to retry shortly rather than piling on.
    holdingLock = await acquireResearchLock(cacheKey);
    if (!holdingLock) {
      res.status(503).json({ error: BUSY_MESSAGE });
      return;
    }
  }

  // Circuit breaker: total fresh researches per day across all visitors,
  // so a launch spike can't drain the API balance. Checked before the
  // personal quota so a capacity refusal never costs the visitor a slot.
  const capCheck = await checkGlobalDailyCap();
  if (capCheck.capped && !isOwnerRequest(req)) {
    await releaseResearchLock(cacheKey);
    res.status(503).json({ error: CAPACITY_MESSAGE });
    return;
  }

  let rateLimit;
  if (isOwnerRequest(req)) {
    // The owner testing their own site never consumes or hits the quota.
    rateLimit = { enforced: false, allowed: true, count: 0 };
  } else try {
    rateLimit = await checkAndIncrementDailyCount(ip);
  } catch (err) {
    // If the rate limiter itself fails (e.g. Upstash is briefly down),
    // fail open rather than blocking every user's research.
    rateLimit = { enforced: false, allowed: true, count: 0 };
  }
  if (!rateLimit.allowed) {
    await releaseResearchLock(cacheKey);
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
5. Write for a quick scan, like a product verdict: a two-sentence bottom line (40 words max) and exactly three evidence bullets (14 words max each). Leave out background that does not change the rating.

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
2. Search the web for independent reviews, user ratings, common complaints, and any trust/scam red flags. Prioritize sources that are not the brand's own marketing. Also record this product's own buy links: the maker's or store's product page in url (not Amazon), and — from one dedicated search for this product on Amazon — its Amazon product page in amazon_url when one genuinely appears AND appears available to buy (a price or buying options in what you saw; a listing showing 'Currently unavailable', no price, or signs of being discontinued counts as no listing — set null), otherwise null; never invent either link. Give the Amazon page in canonical form, https://www.amazon.com/dp/<ASIN>.
3. Also research whether there are well-regarded competing products or brands in the same category, and whether independent reviews suggest they're better value or better quality. For each alternative you name, include a real link from your research to the maker's or store's own page for it — the product page where a shopper can buy it when your research surfaced one, otherwise a credible independent review of it — never an invented URL. ALSO, for each alternative, run one dedicated search for that product on Amazon (for example, search for the product name together with amazon.com) and, when an Amazon listing for it genuinely appears and appears available to buy (same availability test as the main product — 'Currently unavailable' or discontinued-looking counts as no listing), record that Amazon product page separately in amazon_url in canonical /dp/<ASIN> form; when none appears, set amazon_url to null rather than guessing one — the site adds its own Amazon search link in that case. For each alternative also include: a one-line blurb on who it suits; its approximate price ONLY if a price actually appeared in a source you read (otherwise null — never guess a price); and a product image URL ONLY if one actually appeared in your search results (otherwise null — never construct an image URL). Also RATE each alternative the same way you rate the main product — a verdict label and a 0-10 worth-it score from the research you did on it, using the same score anchors and the same missing-evidence cap; give a null rating only when you found too little on it to judge honestly.
4. Weigh all of this into an overall purchase verdict. This is about whether the product is actually worth buying and how it compares to alternatives — not only whether it's a scam.

Score with worth_it_score using these anchors, and make the score agree with your verdict label: 9-10 excellent, strong independent praise (Great Buy); 7-8 good and well reviewed with only minor caveats (Great Buy); 5-6 genuinely mixed evidence (Decent); 3-4 weak — poor value, recurring complaints, or clearly better alternatives (Skip It); 0-2 nothing verifiable to recommend (Skip It, or Avoid when there are active scam or deception signals).
Hard rule on missing evidence: if your research finds virtually no independent reviews, user ratings, or third-party coverage of the brand, the score cannot exceed 2. An invisible product is not a neutral product, and "no complaints found" about a brand nobody reviews is not a positive. Social media likes, follower counts, and the brand's own posts are marketing, not evidence, and never raise a score.

Also distill your findings into pros and cons: up to 3 bullets each, at most 10 words per bullet, drawn only from what your research actually found. Pros are the concrete case for buying; cons are the concrete case against (including a missing review footprint when that's what you found). No generic filler on either side.

Keep the summary to a bottom line: at most 2 sentences and 32 words. The pros and cons carry the detail, and the summary must not repeat them. Keep each alternative's reason and blurb to 10 words or fewer.

Once your research is complete, call the submit_verdict tool exactly once with your final findings. Do not write your answer as plain text — use the tool.`;
  }

  try {
    const { ok, status, data } = await callAnthropic(apiKey, {
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, tool],
    });
    if (!ok) {
      res.status(status === 429 || status === 529 ? 503 : 502).json({ error: friendlyApiError(status) });
      return;
    }

    const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === toolName);
    if (toolUse) {
      await enrichAlternativeImages(toolUse.input);
      await replaceDeadAmazonLinks(toolUse.input);
      await writeCache(cacheKey, toolUse.input);
      await logUsage(ip, isFactCheck, hasCaption ? caption : query, false, toolUse.input.verdict_label || toolUse.input.rating);
      res.status(200).json(tagResultAlternatives(toolUse.input));
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
      await enrichAlternativeImages(parsedText);
      await replaceDeadAmazonLinks(parsedText);
      await writeCache(cacheKey, parsedText);
      await logUsage(ip, isFactCheck, hasCaption ? caption : query, false, parsedText.verdict_label || parsedText.rating);
      res.status(200).json(tagResultAlternatives(parsedText));
      return;
    } catch {
      const match = joined.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsedMatch = JSON.parse(match[0]);
          await enrichAlternativeImages(parsedMatch);
          await replaceDeadAmazonLinks(parsedMatch);
          await writeCache(cacheKey, parsedMatch);
          await logUsage(ip, isFactCheck, hasCaption ? caption : query, false, parsedMatch.verdict_label || parsedMatch.rating);
          res.status(200).json(tagResultAlternatives(parsedMatch));
          return;
        } catch {
          // fall through to the error below
        }
      }
      res.status(502).json({ error: "Couldn't parse the findings into a report. Try again." });
    }
  } catch (err) {
    res.status(502).json({ error: "The research hit a snag — please try again in a moment." });
  } finally {
    await releaseResearchLock(cacheKey);
  }
}
