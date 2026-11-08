// Vercel Serverless Function: /api/chat
// "Ask the Jury" — follow-up chat about a finished product verdict.
//
// The visitor has a verdict on screen and asks questions about it: is it
// good for their situation, how it compares, whether a competitor beats
// it. The chat model (Haiku — fast and cheap, because the heavy research
// is already done) may ONLY use the findings inside that verdict, which
// the client sends along with each message. It cannot browse, and it is
// instructed to say so when the findings don't cover a question instead
// of inventing facts. Competitor recommendations come from the verdict's
// own researched alternatives, with their real links.
//
// Abuse guard: chat is not a free general-purpose chatbot — a per-visitor
// daily message cap (separate from the research quota) keeps it bounded,
// and the system prompt steers off-topic questions back to the product.

import {
  getClientIp,
  getUpstashConfig,
  callAnthropic,
  friendlyApiError,
  tagAmazonUrl,
  amazonAssociateTag,
  isOwnerRequest,
} from "./_shared.js";

const CHAT_DAILY_LIMIT = 30;

async function checkAndIncrementChatCount(ip) {
  const cfg = getUpstashConfig();
  if (!cfg) return { allowed: true };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const key = `chat-count:${ip}:${today}`;
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
    return { allowed: typeof count !== "number" || count <= CHAT_DAILY_LIMIT };
  } catch {
    return { allowed: true }; // fail open, same as the research limiter
  }
}

// Only the fields the chat is allowed to know, each truncated — the
// client holds the verdict, so treat what it sends as untrusted input.
function sanitizeVerdict(v) {
  if (!v || typeof v !== "object") return null;
  const str = (x, n) => (typeof x === "string" ? x.slice(0, n) : "");
  const list = (x, n, m) =>
    Array.isArray(x) ? x.filter((i) => typeof i === "string").slice(0, n).map((i) => i.slice(0, m)) : [];
  return {
    product_name: str(v.product_name, 200),
    verdict_label: str(v.verdict_label, 40),
    worth_it_score: typeof v.worth_it_score === "number" ? v.worth_it_score : null,
    summary: str(v.summary, 1500),
    pros: list(v.pros, 6, 200),
    cons: list(v.cons, 6, 200),
    alternatives: Array.isArray(v.alternatives)
      ? v.alternatives.slice(0, 5).map((a) => ({
          name: str(a?.name, 120),
          // Tag here, server-side: whatever copy of the verdict the
          // client is holding, a recommended Amazon alternative leaves
          // this endpoint carrying Fact Jury's affiliate tag.
          url: tagAmazonUrl(str(a?.url, 300)),
          blurb: str(a?.blurb, 300),
          price_text: str(a?.price_text, 60) || null,
          verdict_label: str(a?.verdict_label, 40) || null,
          worth_it_score: typeof a?.worth_it_score === "number" ? a.worth_it_score : null,
        }))
      : [],
    sources: Array.isArray(v.sources)
      ? v.sources.slice(0, 8).map((s) => ({ title: str(s?.title, 150), note: str(s?.note, 200) }))
      : [],
  };
}

function findingsText(v) {
  const lines = [
    `Product: ${v.product_name}`,
    `Verdict: ${v.verdict_label}${v.worth_it_score != null ? ` — worth-it score ${v.worth_it_score}/10` : ""}`,
    `Reasoning: ${v.summary}`,
  ];
  if (v.pros.length) lines.push(`Pros:\n${v.pros.map((p) => `- ${p}`).join("\n")}`);
  if (v.cons.length) lines.push(`Cons:\n${v.cons.map((c) => `- ${c}`).join("\n")}`);
  if (v.alternatives.length) {
    lines.push(
      `Researched alternatives:\n${v.alternatives
        .map(
          (a) =>
            `- ${a.name}${a.price_text ? ` (approx. ${a.price_text})` : ""}: ${a.blurb} Link: ${a.url}${a.verdict_label ? ` Jury rating for this alternative: ${a.verdict_label}${a.worth_it_score != null ? ` (${a.worth_it_score}/10)` : ""}.` : ""}`
        )
        .join("\n")}`
    );
  }
  if (v.sources.length) {
    lines.push(`Sources behind the verdict:\n${v.sources.map((s) => `- ${s.title}${s.note ? ` — ${s.note}` : ""}`).join("\n")}`);
  }
  return lines.join("\n\n");
}

const SYSTEM = `You are the Fact Jury assistant, answering a shopper's follow-up questions about ONE product verdict. The research findings are below — they are the ONLY facts you may use. You cannot browse or look anything new up.

Rules:
- Answer questions about this product, how it fits the shopper's situation, and how it compares to the researched alternatives.
- When the shopper asks whether something better exists, recommend from the researched alternatives only, explain briefly why it beats (or doesn't beat) the checked product, and include its link exactly as given.
- Never invent prices, specs, links, reviews, or facts that are not in the findings. If the findings don't cover a question, say so plainly and suggest they run a fresh check on that product from the search bar.
- Keep answers short: a few sentences, or a short list when comparing. Plain, friendly, direct.
- Judge products, never people. If asked something unrelated to this product or shopping for it, politely steer back to the verdict.`;

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
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
    return;
  }

  const { verdict, messages } = req.body || {};
  const cleanVerdict = sanitizeVerdict(verdict);
  if (!cleanVerdict || !cleanVerdict.product_name) {
    res.status(400).json({ error: "Missing the verdict to chat about." });
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Missing your question." });
    return;
  }
  const history = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 600) }));
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    res.status(400).json({ error: "Missing your question." });
    return;
  }

  const ip = getClientIp(req);
  const cap = isOwnerRequest(req) ? { allowed: true } : await checkAndIncrementChatCount(ip);
  if (!cap.allowed) {
    res.status(429).json({ error: "You've reached today's chat limit — the verdict above still has the full findings." });
    return;
  }

  const { ok, status, data } = await callAnthropic(
    apiKey,
    {
      model: "claude-haiku-4-5",
      max_tokens: 600,
      system: `${SYSTEM}\n\n--- FINDINGS ---\n${findingsText(cleanVerdict)}`,
      messages: history,
    },
    { timeoutMs: 30000 }
  );
  if (!ok) {
    res.status(status === 429 || status === 529 ? 503 : 502).json({ error: friendlyApiError(status) });
    return;
  }
  let reply = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!reply) {
    res.status(502).json({ error: "The jury didn't answer — try asking that another way." });
    return;
  }
  // Safety pass: if the answer itself contains a bare Amazon link (the
  // model may quote one from the reasoning text), tag it too — a
  // recommended product must never leave without the affiliate tag.
  reply = reply.replace(/https?:\/\/[^\s<)"']+/gi, (u) => tagAmazonUrl(u));

  const hasAmazonAlternative = cleanVerdict.alternatives.some((a) => {
    try {
      return /amazon\./i.test(new URL(a.url).hostname);
    } catch {
      return false;
    }
  });
  res.status(200).json({
    reply,
    amazon_associate: Boolean(amazonAssociateTag()) && hasAmazonAlternative,
  });
}
