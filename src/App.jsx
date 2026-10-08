import React, { useState } from "react";
import { Search, FileWarning, ShieldCheck, ShieldAlert, ShieldX, Ban, Link2, Loader2, ChevronRight, ExternalLink, Info, Stamp } from "lucide-react";

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
const SLATE = "#6B6459";

const VERDICTS = {
  "Great Buy": { color: GREEN, label: "APPROVED", Icon: ShieldCheck, rotate: "-6deg" },
  "Decent": { color: AMBER, label: "MIXED", Icon: ShieldAlert, rotate: "3deg" },
  "Skip It": { color: SLATE, label: "PASS", Icon: Ban, rotate: "-4deg" },
  "Avoid": { color: RUST, label: "AVOID", Icon: ShieldX, rotate: "5deg" },
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

// Stages the whole flow moves through. Only one thing renders below the
// link input at a time, driven off this.
// idle -> fetching -> (need-caption -> researching) | researching -> done
//                   \-> error (from any step)
export default function FactChecker() {
  const [searchText, setSearchText] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [proxyUrl, setProxyUrl] = useState("/api/oembed");
  const [showTokenHelp, setShowTokenHelp] = useState(false);

  const [stage, setStage] = useState("idle"); // idle | fetching | need-caption | researching | done | error
  const [errorMessage, setErrorMessage] = useState("");
  const [manualCaption, setManualCaption] = useState("");
  const [research, setResearch] = useState(null);

  const verdictMeta = research?.verdict_label ? VERDICTS[research.verdict_label] : null;

  async function fetchCaption(postUrl) {
    let endpoint = `${proxyUrl}?url=${encodeURIComponent(postUrl)}`;
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
        "The post-lookup proxy didn't return JSON — likely it isn't running yet (e.g. you're on a plain `npm run dev` " +
          "server, which doesn't execute /api functions). Deploy to Vercel, or run `vercel dev` locally, to test this."
      );
    }
    if (!res.ok) {
      throw new Error(data?.error || data?.error?.message || `Proxy returned ${res.status}`);
    }
    return (data.description && data.description.trim()) || (data.title && data.title.trim()) || "";
  }

  async function runResearch(payload) {
    setStage("researching");
    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const raw = await response.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          "The research proxy didn't return JSON — likely it isn't deployed yet, or ANTHROPIC_API_KEY isn't set on the server."
        );
      }
      if (!response.ok) {
        throw new Error(data?.error || `Proxy returned ${response.status}`);
      }
      let parsed = data;
      if (typeof data === "string") {
        parsed = JSON.parse(stripFences(data));
      }
      setResearch(parsed);
      setStage("done");
    } catch (err) {
      setStage("error");
      setErrorMessage(err.message || "Something went wrong while researching.");
    }
  }

  // One search bar, two kinds of input: an Instagram link goes through the
  // fetch-the-post flow, anything else is treated as a brand/product name.
  function looksLikeLink(text) {
    return /^https?:\/\//i.test(text) || /^www\./i.test(text) || /instagram\.com\//i.test(text);
  }

  async function handleSubmit() {
    const text = searchText.trim();
    if (!text) return;
    if (looksLikeLink(text)) {
      await handleRun(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } else {
      await handleSearchBrand(text);
    }
  }

  async function handleRun(linkText) {
    setErrorMessage("");
    setResearch(null);
    setManualCaption("");

    const clean = extractShortcode(linkText);
    if (!clean) {
      setStage("error");
      setErrorMessage("Links need to be Instagram posts. To look up anything else, just type the brand name.");
      return;
    }

    setStage("fetching");
    try {
      const caption = await fetchCaption(clean);
      if (caption) {
        await runResearch({ caption });
      } else {
        setStage("need-caption");
      }
    } catch (err) {
      setStage("error");
      setErrorMessage(
        err.message?.includes("Failed to fetch")
          ? "Couldn't reach the proxy — check the proxy endpoint below is correct and deployed."
          : err.message || "Couldn't fetch that post."
      );
    }
  }

  async function handleSearchBrand(name) {
    setErrorMessage("");
    setResearch(null);
    setManualCaption("");
    await runResearch({ query: name });
  }

  function handleManualContinue() {
    if (!manualCaption.trim()) return;
    runResearch({ caption: manualCaption.trim() });
  }

  const busy = stage === "fetching" || stage === "researching";

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
              Fat Checker
            </h1>
            <p className="text-xs mt-1 opacity-70">A dossier for every product someone tagged you in.</p>
          </div>
          <FileWarning size={28} strokeWidth={1.5} style={{ color: RUST }} />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Exhibit A: intake */}
        <section>
          <SectionLabel index="A" title="The Subject" />
          <div className="mt-4 space-y-3">
            <p className="text-sm leading-relaxed opacity-80">
              Type a <strong>brand or product name</strong>, or paste a link to an{" "}
              <strong>Instagram post</strong>. Either way, we'll research it and tell you if it's worth buying.
            </p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmit();
              }}
            >
              <div className="flex-1 flex items-center border px-3" style={{ borderColor: INK, background: "#fff" }}>
                <Search size={16} className="opacity-50 shrink-0" />
                <input
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Type a brand name or paste an Instagram link"
                  maxLength={500}
                  disabled={busy}
                  className="w-full bg-transparent outline-none px-2 py-2.5 text-sm disabled:opacity-60"
                />
              </div>
              <button
                type="submit"
                disabled={busy || !searchText.trim()}
                className="px-4 flex items-center gap-2 text-sm font-medium text-white disabled:opacity-60 shrink-0"
                style={{ background: INK }}
              >
                {stage === "fetching" ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Fetching…
                  </>
                ) : stage === "researching" ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Researching…
                  </>
                ) : (
                  <>
                    <Search size={16} /> Run the research
                  </>
                )}
              </button>
            </form>

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
                  This app looks up the post through a small server-side proxy instead of Meta directly — browsers
                  can't call graph.facebook.com themselves. The default <code>/api/oembed</code> works once this app
                  is deployed alongside the included proxy function. It won't resolve in this chat preview, since
                  there's no backend running here — deploy first, then test live. Point this field at a full URL if
                  your proxy lives on a different domain.
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
                  Not required — public posts look up tokenless through the proxy, capped at 1,000 requests/hour. Set{" "}
                  <code>META_ACCESS_TOKEN</code> as an environment variable on your proxy for a shared 5M/day ceiling
                  instead of typing one here per user.
                </p>
              </div>
            )}

            {stage === "error" && (
              <p className="text-sm" style={{ color: RUST }}>
                {errorMessage}
              </p>
            )}
          </div>
        </section>

        {/* Exhibit B: fallback when the caption couldn't be auto-read */}
        {stage === "need-caption" && (
          <section>
            <SectionLabel index="B" title="One More Thing" />
            <div className="mt-4 space-y-3">
              <p className="text-sm leading-relaxed">
                This post's caption couldn't be read automatically (common on some posts — Instagram doesn't always
                expose it to an automated lookup). Open the post, copy the caption, and paste it here to continue.
              </p>
              <div className="flex items-center gap-3">
                <a
                  href={/^https?:\/\//i.test(searchText.trim()) ? searchText.trim() : `https://${searchText.trim()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium hover:underline flex items-center gap-1"
                  style={{ color: INK }}
                >
                  Open post on Instagram <ExternalLink size={12} />
                </a>
                <button
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      if (text) setManualCaption(text);
                    } catch {
                      setErrorMessage("Couldn't read the clipboard — paste into the box manually instead.");
                    }
                  }}
                  className="text-xs font-medium hover:underline opacity-70 hover:opacity-100"
                >
                  Paste from clipboard
                </button>
              </div>
              <textarea
                value={manualCaption}
                onChange={(e) => setManualCaption(e.target.value)}
                rows={4}
                placeholder="Paste the post's caption here…"
                className="w-full text-sm p-3 border outline-none"
                style={{ borderColor: INK, background: "#fff" }}
              />
              <button
                onClick={handleManualContinue}
                disabled={!manualCaption.trim()}
                className="px-4 py-2.5 text-sm font-medium text-white flex items-center gap-2 disabled:opacity-50"
                style={{ background: INK }}
              >
                Continue with this caption <ChevronRight size={16} />
              </button>
            </div>
          </section>
        )}

        {/* Exhibit C: findings */}
        {stage === "done" && research && verdictMeta && (
          <section>
            <SectionLabel index={stage === "need-caption" ? "C" : "B"} title="The Findings" />

            <div className="mt-4 grid sm:grid-cols-[auto_1fr] gap-6 items-start">
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
                <div className="text-[10px] mt-1 tracking-wide">{research.verdict_label.toUpperCase()}</div>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Product identified</p>
                  <p className="text-sm font-medium">{research.product_name}</p>
                </div>

                <div>
                  <p className="text-xs uppercase tracking-wide opacity-60 mb-1">
                    Worth-it score — {research.worth_it_score}/10
                  </p>
                  <WorthBar score={research.worth_it_score} color={verdictMeta.color} />
                </div>

                <div>
                  <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Reasoning</p>
                  <p className="text-sm leading-relaxed">{research.summary}</p>
                </div>
              </div>
            </div>

            {research?.alternatives?.length > 0 && (
              <div className="mt-8">
                <p className="text-xs uppercase tracking-wide opacity-60 mb-2">Worth comparing to</p>
                <ul className="space-y-3">
                  {research.alternatives.map((alt, i) => (
                    <li key={i} className="p-3 border" style={{ borderColor: PAPER_LINE, background: "#fff" }}>
                      <p className="text-sm font-medium">{alt.name}</p>
                      {alt.reason && <p className="text-xs opacity-70 mt-0.5">{alt.reason}</p>}
                    </li>
                  ))}
                </ul>
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
        own judgment before purchasing.{" "}
        <a href="/privacy.html" className="underline hover:opacity-80">
          Privacy Policy
        </a>
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

function WorthBar({ score, color }) {
  const pct = Math.max(0, Math.min(10, score)) * 10;
  return (
    <div className="h-2 w-full bg-white border" style={{ borderColor: PAPER_LINE }}>
      <div className="h-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}
