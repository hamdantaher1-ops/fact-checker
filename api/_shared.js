// Shared server helpers for the Fact Jury API functions (research + quick).
// Vercel does not route files whose names start with "_" as endpoints, so
// this module is import-only.
//
// Holds the Upstash plumbing both functions rely on — daily rate limiting,
// the verdict result cache, usage logging — plus the Amazon Associates
// link tagger. Keeping one copy here means /api/research and /api/quick
// can never drift apart on cache keys or quota keys.

import { createHash } from "node:crypto";

export const DAILY_LIMIT = 5;

export function stripFences(text) {
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
export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

export function getUpstashConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

function dailyCountKey(ip) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return `research-count:${ip}:${today}`;
}

// Talks to Upstash Redis over its REST API (no extra npm package needed).
// Returns { limited: true } and skips enforcement entirely if the two env
// vars aren't set, so the app still works before you finish setting up
// the rate limiter.
export async function checkAndIncrementDailyCount(ip) {
  const cfg = getUpstashConfig();
  if (!cfg) {
    return { enforced: false, allowed: true, count: 0 };
  }
  const { url, token } = cfg;

  const key = dailyCountKey(ip);

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

// Reads today's count WITHOUT incrementing. /api/quick uses this so the
// quick + full pair costs exactly one quota unit: the quick call only
// peeks (and refuses when the visitor is already at the limit), while the
// paired /api/research call performs the single real increment.
export async function peekDailyCount(ip) {
  const cfg = getUpstashConfig();
  if (!cfg) return 0;
  try {
    const r = await fetch(`${cfg.url}/get/${encodeURIComponent(dailyCountKey(ip))}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    const data = await r.json();
    const n = typeof data?.result === "string" ? parseInt(data.result, 10) : data?.result;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // fail open, same as the limiter itself
  }
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

// This number versions the SHAPE of a stored verdict — the fields the
// readers (research, quick, chat) rely on — not the app release, the
// prompts, the scoring wording, or the page design. It deliberately
// stays at 7, the version the current live build writes, so verdicts
// already in the cache remain reachable. Do NOT bump it for prompt,
// copy, link-hygiene, or display changes: every bump makes every
// existing key unreachable and silently flushes the whole cache (that
// is how repeat checks kept re-running full research after unrelated
// deploys). Bump it only if a stored field changes incompatibly.
const CACHE_SCHEMA_VERSION = 7;
const CACHE_KEY_PREFIX = `verdict-cache:v${CACHE_SCHEMA_VERSION}`;

// Prefixes written by earlier deployments (v3, v5, v6 — see the warning
// above). Reads fall back to these so a version bump — which must never
// happen for shape-compatible changes, but has repeatedly happened in
// this project's history — no longer orphans every verdict the previous
// build stored: a repeat check still finds the older copy instead of
// paying for a full re-research. Writes always use the current prefix.
const LEGACY_CACHE_KEY_PREFIXES = ["verdict-cache:v6", "verdict-cache:v5", "verdict-cache:v3"];

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

// Canonical subject text for cache keys: case, accents, whitespace and
// punctuation all fold away, so "IM8 Welcome Kit", "im8  welcome-kit!"
// and "IM8 — Welcome Kit" are the same check. (The previous typed-query
// key folded only case and whitespace, so a stray hyphen, trademark
// symbol or exclamation mark produced a different key and a full
// re-research.)
export function normalizeSubjectText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[™®©]/g, "") // NFKD would turn ™ into the letters "tm"
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cacheKeyFromBasis(isFactCheck, basis) {
  const digest = createHash("sha256").update(basis).digest("hex").slice(0, 32);
  return `${CACHE_KEY_PREFIX}:${isFactCheck ? "factcheck" : "product"}:${digest}`;
}

// The cache key decides what counts as "the same check". A check that came
// from a post link is keyed on the link itself: the link never changes,
// while the caption text fetched from the post can come back worded
// slightly differently between visits (wrapper lines, line breaks), which
// used to make every repeat of the same ad miss the cache. Typed checks
// key on the normalized text.
export function cacheKeyFor(isFactCheck, caption, query, link) {
  let basis;
  if (typeof link === "string" && link.trim()) {
    basis = `link:${normalizeLink(link)}`;
  } else if (typeof caption === "string" && caption.trim()) {
    // Belt-and-braces: drop an Instagram engagement wrapper if one ever
    // reaches the key ("12,345 Likes, 678 Comments - user on Instagram: \"…\"")
    const unwrapped = caption
      .trim()
      .replace(/^[\d,.]+\s+likes?,\s*[\d,.]+\s+comments?\s+-\s+.*?on instagram:\s*"/, "")
      .replace(/"$/, "");
    basis = `caption:${normalizeSubjectText(unwrapped)}`;
  } else {
    basis = `query:${normalizeSubjectText(query)}`;
  }
  return cacheKeyFromBasis(isFactCheck, basis);
}

// The key a finished verdict is ALSO stored under, derived from the
// subject the research actually resolved to (product_name for a product
// verdict, claim for a fact-check). A shopper who first arrived via a
// post link and later types the product's name — or who typed a loose
// variant the research canonicalized — lands on this key, so the two
// differently-worded checks converge on one saved verdict instead of
// each paying for its own research.
export function cacheKeyForResultSubject(isFactCheck, value) {
  const subject = isFactCheck ? value?.claim : value?.product_name;
  if (typeof subject !== "string" || !normalizeSubjectText(subject)) return null;
  return cacheKeyFor(isFactCheck, null, subject, null);
}

// A word-order-insensitive key for product names/queries: the same
// words in a different order ("Welcome Kit IM8" vs "IM8 Welcome Kit")
// are the same product. Product-mode only — a claim's word order is
// part of its meaning, so fact-checks never use this.
export function cacheKeyForProductTokens(text) {
  const normalized = normalizeSubjectText(text);
  if (!normalized) return null;
  const tokens = [...new Set(normalized.split(" "))].sort();
  return cacheKeyFromBasis(false, `product-tokens:${tokens.join(" ")}`);
}

// Every key a repeat of this request might legitimately be stored
// under: the request's own primary key, the plain query key (when the
// primary came from a caption), the caption key (when the primary came
// from a link — the same post can be pasted in a different link form,
// e.g. /reel/ instead of /p/, which changes the link key while the
// caption, and its key, stay the same), and the word-order-insensitive
// product key. Lookups try them in order.
export function cacheLookupKeysFor(isFactCheck, caption, query, link) {
  const keys = [cacheKeyFor(isFactCheck, caption, query, link)];
  if (typeof query === "string" && query.trim()) {
    const queryKey = cacheKeyFor(isFactCheck, null, query, null);
    if (!keys.includes(queryKey)) keys.push(queryKey);
    if (!isFactCheck) {
      const tokenKey = cacheKeyForProductTokens(query);
      if (tokenKey && !keys.includes(tokenKey)) keys.push(tokenKey);
    }
  }
  if (typeof link === "string" && link.trim() && typeof caption === "string" && caption.trim()) {
    const captionKey = cacheKeyFor(isFactCheck, caption, null, null);
    if (!keys.includes(captionKey)) keys.push(captionKey);
  }
  return keys;
}

export async function readCachedVerdict(isFactCheck, caption, query, link) {
  const keys = cacheLookupKeysFor(isFactCheck, caption, query, link);
  for (const key of keys) {
    const hit = await readCache(key);
    if (hit) return hit;
  }
  // Legacy prefixes: the same lookup keys as written by earlier builds
  // whose cache version differed. Every current-prefix key starts with
  // CACHE_KEY_PREFIX, so the legacy form is a straight prefix swap.
  for (const legacyPrefix of LEGACY_CACHE_KEY_PREFIXES) {
    for (const key of keys) {
      const hit = await readCache(key.replace(CACHE_KEY_PREFIX, legacyPrefix));
      if (hit) return hit;
    }
  }
  return null;
}

export async function readCache(key) {
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

export async function writeCache(key, value) {
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

// Stores a finished verdict under every key a repeat might look up:
// the request's own primary key, the resolved-subject key (the
// product_name / claim the research settled on), the caption key when
// the check came from a post (a repeat of the same post in a different
// link form — /reel/ vs /p/ — changes the link key but not the caption
// key), and — product mode only — the word-order-insensitive key for
// both the shopper's wording and the product name. This is the write
// half of the convergence the lookup keys above read: however the
// same product is asked about the second time, one of these keys
// matches.
export async function writeCachedVerdict(primaryKey, isFactCheck, value, requestQuery, requestCaption) {
  const keys = new Set([primaryKey]);
  const subjectKey = cacheKeyForResultSubject(isFactCheck, value);
  if (subjectKey) keys.add(subjectKey);
  if (typeof requestCaption === "string" && requestCaption.trim()) {
    keys.add(cacheKeyFor(isFactCheck, requestCaption, null, null));
  }
  if (!isFactCheck) {
    for (const text of [requestQuery, value?.product_name]) {
      const tokenKey = cacheKeyForProductTokens(text);
      if (tokenKey) keys.add(tokenKey);
    }
  }
  await Promise.all([...keys].map((key) => writeCache(key, value)));
}

export async function logUsage(ip, isFactCheck, subjectText, cached, resultLabel) {
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

// --- Amazon Associates tagging ------------------------------------------
// When AMAZON_ASSOCIATE_TAG is set in the Vercel env, any amazon.* URL in
// a result's alternatives gets tag=<value> appended at serve time (never
// double-tagged, and never written into the cached copy — tagging happens
// on the way out, so setting or changing the tag takes effect immediately,
// including on results cached before the tag existed). When the env var is
// unset, links pass through unchanged and earn nothing.

export function amazonAssociateTag() {
  const tag = process.env.AMAZON_ASSOCIATE_TAG;
  return typeof tag === "string" && tag.trim() ? tag.trim() : null;
}

export function isAmazonUrl(url) {
  if (typeof url !== "string") return false;
  try {
    return /(^|\.)amazon\.[a-z.]+$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function tagAmazonUrl(url) {
  const tag = amazonAssociateTag();
  if (!tag || typeof url !== "string") return url;
  try {
    const u = new URL(url);
    if (!/(^|\.)amazon\.[a-z.]+$/i.test(u.hostname)) return url;
    if (!u.searchParams.has("tag")) {
      u.searchParams.set("tag", tag);
    }
    return u.toString();
  } catch {
    return url;
  }
}

// True only for an Amazon URL that actually takes a shopper somewhere
// useful: a product page (/dp/<ASIN>, /gp/product/<ASIN>, possibly behind
// a name slug) or a search-results page carrying a real query. A bare
// amazon.com link lands on the homepage, and any other Amazon path is
// not a place to buy the product — neither is usable as a card link.
export function isUsableAmazonUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (!/(^|\.)amazon\.[a-z.]+$/i.test(u.hostname)) return false;
    if (/(^|\/)(dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}(\/|$)/i.test(u.pathname)) return true;
    if (u.pathname === "/s" && (u.searchParams.get("k") || "").trim()) return true;
    return false;
  } catch {
    return false;
  }
}

// Extract the ASIN from an Amazon URL, whatever path shape it arrived
// in. Research results sometimes carry a product's ASIN behind a
// non-product path — most often /clp/<ASIN>, a landing-page form that
// does not reliably open the product page — when the canonical buy link
// is /dp/<ASIN>. Returns null when the URL is not Amazon or carries no
// ASIN.
export function extractAmazonAsin(url) {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)amazon\.[a-z.]+$/i.test(u.hostname)) return null;
    const m = u.pathname.match(
      /(?:^|\/)(?:dp|gp\/product|gp\/aw\/d|clp)\/([A-Z0-9]{10})(?:\/|$)/i
    );
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

// The canonical Amazon product-page URL for any Amazon URL that carries
// an ASIN (see above); any other URL passes through unchanged. The
// affiliate tag is NOT added here — tagAmazonUrl does that downstream.
export function canonicalAmazonUrl(url) {
  const asin = extractAmazonAsin(url);
  return asin ? `https://www.amazon.com/dp/${asin}` : url;
}

// The standard Amazon search-results URL for a product name. Used as the
// card's Amazon link when the research found no Amazon product page for
// an alternative: it always lands the shopper on Amazon with that exact
// product searched, and it carries the affiliate tag like any other
// Amazon link. It is a search link, never a fabricated product page.
export function amazonSearchUrl(name) {
  if (typeof name !== "string" || !name.trim()) return null;
  return `https://www.amazon.com/s?k=${encodeURIComponent(name.trim())}`;
}

// Returns the full result with alternative links prepared for the cards,
// plus an `amazon_associate: true` marker when the tag is configured, so
// the frontend knows to show the Amazon Associates disclosure line.
// Every alternative leaves with a working amazon_url: the real Amazon
// product page when the research found one (or when its main url IS the
// Amazon page), otherwise the Amazon search link for its name — so the
// card's Amazon link is never missing. Tagging happens here, at serve
// time, never in the cached copy.
export function tagResultAlternatives(result) {
  if (!result || typeof result !== "object") return result;
  const tag = amazonAssociateTag();
  const out = { ...result };
  if (tag) out.amazon_associate = true;
  // The main product gets the same link treatment as its alternatives:
  // its store link tagged, and an amazon_url that is always usable —
  // the real Amazon product page when the research found one (or when
  // its own store url IS the Amazon page), otherwise the tagged Amazon
  // search link for the product's name. Product verdicts only: a
  // fact-check result carries a rating, not a product to buy.
  if (
    typeof result.verdict_label === "string" &&
    typeof result.product_name === "string" &&
    result.product_name.trim()
  ) {
    // Canonicalize first: an Amazon link carrying an ASIN behind a
    // non-product path (e.g. /clp/<ASIN>) becomes the real /dp/ page.
    if (typeof out.url === "string") out.url = tagAmazonUrl(canonicalAmazonUrl(out.url));
    if (typeof out.amazon_url === "string") out.amazon_url = canonicalAmazonUrl(out.amazon_url);
    if (!isUsableAmazonUrl(out.amazon_url) && isUsableAmazonUrl(out.url)) {
      out.amazon_url = out.url;
    }
    if (!isUsableAmazonUrl(out.amazon_url)) {
      out.amazon_url = amazonSearchUrl(result.product_name);
    }
    if (out.amazon_url) out.amazon_url = tagAmazonUrl(out.amazon_url);
  }
  if (Array.isArray(result.alternatives)) {
    out.alternatives = result.alternatives.map((alt) => {
      if (!alt || typeof alt !== "object") return alt;
      const next = { ...alt };
      if (typeof next.url === "string") next.url = tagAmazonUrl(canonicalAmazonUrl(next.url));
      if (typeof next.amazon_url === "string") next.amazon_url = canonicalAmazonUrl(next.amazon_url);
      // The research sometimes returns an amazon_url that goes nowhere
      // useful — a bare amazon.com link lands the shopper on the Amazon
      // homepage. Only a real product page or a real search link may
      // survive; anything else is replaced by the search link for the
      // product's exact name, which always lands on that product.
      if (!isUsableAmazonUrl(next.amazon_url) && isUsableAmazonUrl(next.url)) {
        next.amazon_url = next.url;
      }
      if (!isUsableAmazonUrl(next.amazon_url)) {
        next.amazon_url = amazonSearchUrl(next.name);
      }
      if (next.amazon_url) next.amazon_url = tagAmazonUrl(next.amazon_url);
      return next;
    });
  }
  return out;
}

// --- Amazon availability probe --------------------------------------------
// Best-effort check that an Amazon product page is still a page a shopper
// can buy from. Returns "dead" ONLY on unambiguous signals seen in a full
// product page: an HTTP 404/410, Amazon's "couldn't find that page" error
// page, or a real product page whose availability reads "Currently
// unavailable". Everything else — robot-check interstitials (Amazon walls
// datacenter IPs, so a block says nothing about the listing), timeouts,
// network errors, other statuses — is "unknown", and unknown NEVER
// removes a link. This probe can therefore only catch listings that are
// provably gone; it cannot prove a listing is in stock.

export async function probeAmazonProductUrl(url) {
  const asin = extractAmazonAsin(url);
  if (!asin) return "unknown";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const r = await fetch(`https://www.amazon.com/dp/${asin}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
    });
    if (r.status === 404 || r.status === 410) return "dead";
    if (!r.ok) return "unknown";
    const body = await r.text();
    // Robot walls and interstitials are small and carry no product title;
    // they prove nothing about the listing.
    if (body.length < 20000 || !body.includes("productTitle")) return "unknown";
    if (/couldn.t find that page/i.test(body)) return "dead";
    if (/id="availability"[\s\S]{0,300}?Currently unavailable/i.test(body)) return "dead";
    return "live";
  } catch {
    return "unknown"; // fail open — a probe failure never costs a link
  } finally {
    clearTimeout(timer);
  }
}

// Runs the probe over a FRESH research result (main product + each
// alternative) before it is cached or served, and nulls the Amazon link
// of any listing the probe proved dead — tagResultAlternatives then
// substitutes the tagged Amazon search link for that product's name, so
// no card ever points at a provably dead listing. Mutates the result in
// place; every failure mode leaves the result exactly as it was.
export async function replaceDeadAmazonLinks(result) {
  if (!result || typeof result !== "object") return result;
  try {
    const targets = [];
    const consider = (holder) => {
      if (!holder || typeof holder !== "object") return;
      const candidate = [holder.amazon_url, holder.url].find(
        (u) => typeof u === "string" && extractAmazonAsin(u)
      );
      if (candidate) targets.push({ holder, asin: extractAmazonAsin(candidate) });
    };
    if (typeof result.verdict_label === "string") consider(result);
    if (Array.isArray(result.alternatives)) result.alternatives.forEach(consider);
    if (targets.length === 0) return result;
    const verdicts = await Promise.all(
      targets.map((t) => probeAmazonProductUrl(`https://www.amazon.com/dp/${t.asin}`))
    );
    targets.forEach((t, i) => {
      if (verdicts[i] !== "dead") return;
      if (extractAmazonAsin(t.holder.amazon_url) === t.asin) t.holder.amazon_url = null;
      if (extractAmazonAsin(t.holder.url) === t.asin) t.holder.url = null;
    });
  } catch {
    // fail open — link hygiene must never break a verdict
  }
  return result;
}

// --- Load & failure hardening -------------------------------------------
// Three protections for launch traffic, all fail-open (if Upstash or the
// network misbehaves, requests proceed as before — a protection must never
// become the outage):
//
// 1. callAnthropic — every Anthropic call goes through one wrapper with a
//    per-attempt timeout and bounded retries on 429 (rate limit), 529
//    (overloaded) and 5xx/network errors, honouring retry-after. Callers
//    turn a final failure into a friendly message (friendlyApiError)
//    instead of leaking the raw provider error to the visitor.
// 2. Research lock — when many visitors check the SAME product at once
//    (a viral post), only the first runs the research; the rest wait for
//    the shared result to land in the cache instead of each paying for a
//    duplicate run and piling onto the API at the same moment.
// 3. Global daily cap — a circuit breaker on total fresh researches per
//    UTC day (env GLOBAL_DAILY_FRESH_CAP, default 1000) so a traffic
//    spike can't quietly drain the API balance. Cached verdicts and
//    followers sharing an in-flight run never touch it.

export const BUSY_MESSAGE =
  "Fact Jury is unusually busy right now — give it a minute and try again.";
export const CAPACITY_MESSAGE =
  "Fact Jury has reached today's research capacity for new checks. Verdicts already researched still load instantly — please try a new check tomorrow.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callAnthropic(apiKey, body, { timeoutMs = 60000, maxAttempts = 3 } = {}) {
  let last = { ok: false, status: 0, data: null };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await r.json().catch(() => null);
      last = { ok: r.ok, status: r.status, data };
      if (r.ok) return last;
      const retryable = r.status === 429 || r.status === 529 || r.status >= 500;
      if (!retryable || attempt === maxAttempts) return last;
      const retryAfter = Number(r.headers.get("retry-after"));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10000)
          : Math.min(1000 * 2 ** (attempt - 1) + Math.random() * 500, 10000);
      await sleep(backoff);
    } catch (err) {
      last = { ok: false, status: 0, data: null, error: err };
      if (attempt === maxAttempts) return last;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

export function friendlyApiError(status) {
  return status === 429 || status === 529 || status === 0
    ? BUSY_MESSAGE
    : "The research hit a snag — please try again in a moment.";
}

function lockKeyFor(cacheKey) {
  return `${cacheKey}:lock`;
}

// SET NX with a 150s TTL: long enough for a full research run plus
// retries, short enough that a crashed run never wedges a product.
export async function acquireResearchLock(cacheKey) {
  const cfg = getUpstashConfig();
  if (!cfg) return true;
  try {
    const r = await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", lockKeyFor(cacheKey), "1", "NX", "EX", "150"]),
    });
    const data = await r.json();
    return data?.result === "OK";
  } catch {
    return true; // fail open
  }
}

export async function releaseResearchLock(cacheKey) {
  const cfg = getUpstashConfig();
  if (!cfg) return;
  try {
    await fetch(`${cfg.url}/del/${encodeURIComponent(lockKeyFor(cacheKey))}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
  } catch {
    // best-effort — the TTL cleans up regardless
  }
}

// Polls the result cache for a verdict another in-flight request is
// producing. A full research takes 45–115s, so patience has to cover
// that (the old ~36s gave up long before the researcher finished and
// the follower fell through to a 503 or a duplicate run). Polls every
// key the verdict may land under — the researcher's write files it
// under the primary key plus the resolved-subject and word-order
// aliases, not just the primary — via the caller's lookup context when
// provided.
export async function waitForCachedResult(cacheKey, { tries = 40, intervalMs = 3000, lookup = null } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(intervalMs);
    const hit = lookup ? await lookup() : await readCache(cacheKey);
    if (hit) return hit;
  }
  return null;
}

export async function checkGlobalDailyCap() {
  const cfg = getUpstashConfig();
  if (!cfg) return { capped: false };
  const parsed = Number(process.env.GLOBAL_DAILY_FRESH_CAP);
  const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
  const today = new Date().toISOString().slice(0, 10);
  const key = `fresh-checks:global:${today}`;
  try {
    const r = await fetch(`${cfg.url}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    const data = await r.json();
    const count = data?.result;
    if (count === 1) {
      await fetch(`${cfg.url}/expire/${encodeURIComponent(key)}/93600`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
    }
    return { capped: typeof count === "number" && count > cap, count };
  } catch {
    return { capped: false }; // fail open
  }
}

// --- Alternative product images ------------------------------------------
// The research model may only report an image URL it actually saw in its
// search results, and search results rarely carry one — so most
// alternatives come back imageless and the cards render without a
// picture. Fill the gap deterministically: fetch each alternative's own
// page and take its og:image, the picture the store itself designates
// for sharing that page. Best-effort and parallel; a store that blocks
// the fetch or has no og:image simply stays imageless, and the card
// already renders fine without one.

async function fetchOgImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: controller.signal,
    });
    if (!r.ok) return null;
    const html = await r.text();
    const tag =
      html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i)?.[0] ||
      html.match(/<meta[^>]+content=["'][^"']+["'][^>]+property=["']og:image/i)?.[0];
    const raw = tag?.match(/content=["']([^"']+)["']/i)?.[1];
    if (!raw) return null;
    const decoded = raw.replace(/&amp;/g, "&").trim();
    const u = new URL(decoded, url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Mutates the result in place: fills image_url for alternatives that
// lack one but have a page URL. Runs before the result is cached, so
// the enriched card is what every later visitor is served too.
export async function enrichAlternativeImages(result) {
  if (!result || !Array.isArray(result.alternatives)) return result;
  const targets = result.alternatives.filter(
    (a) => a && typeof a === "object" && !a.image_url && typeof a.url === "string" && /^https?:\/\//i.test(a.url)
  );
  if (targets.length === 0) return result;
  const images = await Promise.all(targets.map((a) => fetchOgImage(a.url)));
  targets.forEach((a, i) => {
    if (images[i]) a.image_url = images[i];
  });
  return result;
}

// --- Owner bypass ---------------------------------------------------------
// The site owner testing their own product should never hit the visitor
// limits. When OWNER_BYPASS_TOKEN is set in the Vercel env, a request
// carrying that exact value in the x-owner-token header skips the daily
// research quota, the global cap, and the chat cap. The website stores
// the token on the owner's own device after a one-time
// factjury.com/?owner=<token> visit (see App.jsx) and attaches it
// silently from then on. Unset env var = feature off. The daily limit
// is a speed bump against abuse, not a security boundary — this matches
// that threat model.

export function isOwnerRequest(req) {
  const expected = process.env.OWNER_BYPASS_TOKEN;
  if (typeof expected !== "string" || !expected) return false;
  const got = req.headers?.["x-owner-token"];
  return typeof got === "string" && got.length > 0 && got === expected;
}
