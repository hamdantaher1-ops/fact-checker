import React, { useState, useRef, useCallback } from "react";
import { Search, FileWarning, ShieldCheck, ShieldAlert, ShieldX, Link2, Loader2, ChevronRight, ExternalLink, Info, Stamp } from "lucide-react";

// ---------------------------------------------------------------------------
// Design tokens (see plan): case-file / dossier aesthetic.
// Paper background, ink navy type, typewriter mono for report copy,
// a serif for the masthead, stamp-style verdict badges.
// ---------------------------------------------------------------------------
const INK = "#1C2A33";
const PAPER = "#EEEBE2";
const PAPER_LINE = "#D9D4C6";
const RUST = "#A8431F";
const GREEN = "#2F6B4F";
const AMBER = "#B27A16";

const VERDICTS = {
  "good to buy": { color: GREEN, label: "CLEARED", Icon: ShieldCheck, rotate: "-6deg" },
  "not recommended": { color: AMBER, label: "CAUTION", Icon: ShieldAlert, rotate: "4deg" },
  "likely scam": { color: RUST, label: "FLAGGED", Icon: ShieldX, rotate: "-3deg" },
};

function extractShortcode(url) {
  try {
    const u = new URL(url.trim());
    if (!/instagram\.com$/.test(u.hostname.replace(/^www\./, ""))) return null;
    return url.trim();
  } catch {
    return null;
  }
}

function stripFences(text) {
  return text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

export default function FactChecker() {
  const [url, setUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [proxyUrl, setProxyUrl] = useState("/api/oembed");
  const [showTokenHelp, setShowTokenHelp] = useState(false);

  const [oembed, setOembed] = useState(null);
  const [fetchState, setFetchState] = useState("idle"); // idle | loading | error | done
  const [fetchError, setFetchError] = useState("");

  const [manualCaption, setManualCaption] = useState("");
  const [captionLocked, setCaptionLocked] = useState(false);

  const [research, setResearch] = useState(null);
  const [researchState, setResearchState] = useState("idle"); // idle | loading | error | done
  const [researchError, setResearchError] = useState("");

  const embedContainerRef = useRef(null);

  const caption = (oembed?.title && oembed.title.trim()) || manualCaption;

  const loadEmbedScript = useCallback(() => {
    if (window.instgrm) {
      window.instgrm.Embeds.process();
      return;
    }
    const existing = document.getElementById("ig-embed-script");
    if (existing) return;
    const script = document.createElement("script");
    script.id = "ig-embed-script";
    script.src = "https://www.instagram.com/embed.js";
    script.async = true;
    script.onload = () => window.instgrm && window.instgrm.Embeds.process();
    document.body.appendChild(script);
  }, []);

  async function handleFetchPost() {
    setFetchError("");
    setOembed(null);
    setResearch(null);
    setResearchState("idle");
    setManualCaption("");
    setCaptionLocked(false);

    const clean = extractShortcode(url);
    if (!clean) {
      setFetchState("error");
      setFetchError("That doesn't look like an instagram.com link. Paste the full post URL.");
      return;
    }

    setFetchState("loading");
    try {
      let endpoint = `${proxyUrl}?url=${encodeURIComponent(clean)}`;
      if (accessToken.trim()) {
        endpoint += `&access_token=${encodeURIComponent(accessToken.trim())}`;
      }
      const res = await fetch(endpoint);
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          "The proxy didn't return JSON — likely it isn't running yet (e.g. you're on a plain `npm run dev` " +
            "server, which doesn't execute /api functions). Deploy to Vercel, or run `vercel dev` locally, to test this."
        );
      }
      if (!res.ok) {
        throw new Error(data?.error || data?.error?.message || `Proxy returned ${res.status}`);
      }
      setOembed(data);
      setFetchState("done");
      setTimeout(loadEmbedScript, 50);
    } catch (err) {
      setFetchState("error");
      setFetchError(
        err.message?.includes("Failed to fetch")
          ? "Couldn't reach the proxy — check the proxy endpoint below is correct and deployed."
          : err.message || "Couldn't fetch that post."
      );
    }
  }

  async function handleRunResearch() {
    if (!caption.trim()) return;
    setResearchState("loading");
    setResearchError("");
    setResearch(null);

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
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "Research request failed.");

      const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
      const joined = textBlocks.join("\n").trim();
      if (!joined) throw new Error("No answer came back — try again.");

      let parsed;
      try {
        parsed = JSON.parse(stripFences(joined));
      } catch {
        const match = joined.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("Couldn't parse the findings into a report.");
        parsed = JSON.parse(match[0]);
      }
      setResearch(parsed);
      setResearchState("done");
    } catch (err) {
      setResearchState("error");
      setResearchError(err.message || "Something went wrong while researching.");
    }
  }

  const verdictMeta = research?.verdict ? VERDICTS[research.verdict] : null;

  return (
    <div style={{ background: PAPER, color: INK, minHeight: "100%", fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }} className="w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,500;8..60,700&display=swap');
      `}</style>

      {/* Masthead */}
      <header className="border-b" style={{ borderColor: PAPER_LINE }}>
        <div className="max-w-3xl mx-auto px-6 py-7 flex items-baseline justify-between">
          <div>
            <h1 style={{ fontFamily: "'Source Serif 4', Georgia, serif" }} className="text-3xl font-bold tracking-tight">
              Fact Checker
            </h1>
            <p className="text-xs mt-1 opacity-70">A dossier for every product someone tagged you in.</p>
          </div>
          <FileWarning size={28} strokeWidth={1.5} style={{ color: RUST }} />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Exhibit A: intake */}
        <section>
          <SectionLabel index="A" title="The Link" />
          <div className="mt-4 space-y-3">
            <div className="flex gap-2">
              <div className="flex-1 flex items-center border px-3" style={{ borderColor: INK, background: "#fff" }}>
                <Link2 size={16} className="opacity-50 shrink-0" />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.instagram.com/p/..."
                  className="w-full bg-transparent outline-none px-2 py-2.5 text-sm"
                />
              </div>
              <button
                onClick={handleFetchPost}
                disabled={fetchState === "loading"}
                className="px-4 flex items-center gap-2 text-sm font-medium text-white disabled:opacity-60"
                style={{ background: INK }}
              >
                {fetchState === "loading" ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                Fetch
              </button>
            </div>

            <button
              onClick={() => setShowTokenHelp((s) => !s)}
              className="text-xs flex items-center gap-1 opacity-60 hover:opacity-100"
            >
              <Info size={13} /> {showTokenHelp ? "hide advanced options" : "advanced: proxy & token settings"}
            </button>

            {showTokenHelp && (
              <div className="space-y-3">
                <div className="flex items-center border px-3" style={{ borderColor: PAPER_LINE, background: "#fff" }}>
                  <input
                    value={proxyUrl}
                    onChange={(e) => setProxyUrl(e.target.value)}
                    placeholder="/api/oembed"
                    className="w-full bg-transparent outline-none px-2 py-2 text-sm"
                  />
                </div>
                <p className="text-xs leading-relaxed opacity-70">
                  This app calls a small server-side proxy instead of Meta directly — browsers can't call
                  graph.facebook.com themselves (Meta doesn't allow cross-origin reads there). The default{" "}
                  <code>/api/oembed</code> works once this app is deployed alongside the included proxy function. It
                  won't resolve in this chat preview, since there's no backend running here — deploy first, then test
                  live. Point this field at a full URL if your proxy lives on a different domain.
                </p>
                <div className="flex items-center border px-3" style={{ borderColor: PAPER_LINE, background: "#fff" }}>
                  <input
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    type="password"
                    placeholder="app-id|client-token (optional, overrides the proxy's default)"
                    className="w-full bg-transparent outline-none px-2 py-2 text-sm"
                  />
                </div>
                <p className="text-xs leading-relaxed opacity-70">
                  Not required — public posts fetch tokenless through the proxy, capped at 1,000 requests/hour. Set{" "}
                  <code>META_ACCESS_TOKEN</code> as an environment variable on your proxy for a shared 5M/day ceiling
                  instead of typing one here per user.
                </p>
              </div>
            )}

            {fetchState === "error" && (
              <p className="text-sm" style={{ color: RUST }}>
                {fetchError}
              </p>
            )}
          </div>
        </section>

        {/* Exhibit B: the post itself */}
        {oembed && (
          <section>
            <SectionLabel index="B" title="The Post" />
            <div className="mt-4 border" style={{ borderColor: PAPER_LINE, background: "#fff" }}>
              <div
                ref={embedContainerRef}
                className="p-4 flex justify-center [&_iframe]:!max-w-full"
                dangerouslySetInnerHTML={{ __html: oembed.html }}
              />
            </div>

            <div className="mt-4">
              <p className="text-xs uppercase tracking-wide opacity-60 mb-2">Caption used for research</p>
              {oembed.title && oembed.title.trim() ? (
                <p className="text-sm leading-relaxed p-3 border" style={{ borderColor: PAPER_LINE, background: "#fff" }}>
                  {oembed.title}
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs leading-relaxed opacity-70">
                    Meta's oEmbed response doesn't include caption text for this post (common — Instagram stopped
                    reliably returning it, and the rendered embed above lives in a cross-origin frame this app can't
                    read). Paste the caption yourself so the research step has something to work with.
                  </p>
                  <textarea
                    value={manualCaption}
                    onChange={(e) => setManualCaption(e.target.value)}
                    disabled={captionLocked}
                    rows={4}
                    placeholder="Paste the post's caption here…"
                    className="w-full text-sm p-3 border outline-none disabled:opacity-60"
                    style={{ borderColor: INK, background: "#fff" }}
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {/* Exhibit C: research + verdict */}
        {oembed && (
          <section>
            <SectionLabel index="C" title="The Findings" />
            <div className="mt-4">
              <button
                onClick={handleRunResearch}
                disabled={!caption.trim() || researchState === "loading"}
                className="px-4 py-2.5 text-sm font-medium text-white flex items-center gap-2 disabled:opacity-50"
                style={{ background: INK }}
              >
                {researchState === "loading" ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Researching…
                  </>
                ) : (
                  <>
                    Run the research <ChevronRight size={16} />
                  </>
                )}
              </button>
              {!caption.trim() && (
                <p className="text-xs mt-2 opacity-60">Add a caption above first — that's what gets researched.</p>
              )}
              {researchState === "error" && (
                <p className="text-sm mt-2" style={{ color: RUST }}>
                  {researchError}
                </p>
              )}
            </div>

            {research && verdictMeta && (
              <div className="mt-8 grid sm:grid-cols-[auto_1fr] gap-6 items-start">
                <div
                  className="border-4 px-4 py-3 text-center select-none shrink-0 mx-auto sm:mx-0"
                  style={{
                    borderColor: verdictMeta.color,
                    color: verdictMeta.color,
                    transform: `rotate(${verdictMeta.rotate})`,
                  }}
                >
                  <verdictMeta.Icon size={22} className="mx-auto mb-1" />
                  <div className="text-lg font-bold tracking-wider leading-none">{verdictMeta.label}</div>
                  <div className="text-[10px] mt-1 tracking-wide">{research.verdict.toUpperCase()}</div>
                </div>

                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Product identified</p>
                    <p className="text-sm font-medium">{research.product_name}</p>
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">
                      Risk score — {research.risk_score}/10
                    </p>
                    <RiskBar score={research.risk_score} color={verdictMeta.color} />
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Reasoning</p>
                    <p className="text-sm leading-relaxed">{research.summary}</p>
                  </div>
                </div>
              </div>
            )}

            {research?.sources?.length > 0 && (
              <div className="mt-8">
                <p className="text-xs uppercase tracking-wide opacity-60 mb-2">Sources consulted</p>
                <ul className="divide-y" style={{ borderColor: PAPER_LINE }}>
                  {research.sources.map((s, i) => (
                    <li key={i} className="py-3 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium hover:underline break-words"
                          style={{ color: INK }}
                        >
                          {s.title}
                        </a>
                        {s.note && <p className="text-xs opacity-60 mt-0.5">{s.note}</p>}
                      </div>
                      <ExternalLink size={14} className="opacity-40 mt-1 shrink-0" />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="max-w-3xl mx-auto px-6 pb-10 pt-4 text-[11px] opacity-50 leading-relaxed border-t" style={{ borderColor: PAPER_LINE }}>
        <Stamp size={12} className="inline mr-1 -mt-0.5" />
        Verdicts are generated from automated web research and are not professional or legal advice. Always use your
        own judgment before purchasing.
      </footer>
    </div>
  );
}

function SectionLabel({ index, title }) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className="text-xs font-bold px-1.5 py-0.5 border"
        style={{ borderColor: INK, color: INK }}
      >
        {index}
      </span>
      <h2 style={{ fontFamily: "'Source Serif 4', Georgia, serif" }} className="text-lg font-semibold">
        {title}
      </h2>
    </div>
  );
}

function RiskBar({ score, color }) {
  const pct = Math.max(0, Math.min(10, score)) * 10;
  return (
    <div className="h-2 w-full bg-white border" style={{ borderColor: PAPER_LINE }}>
      <div className="h-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}
