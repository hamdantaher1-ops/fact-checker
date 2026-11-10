import React, { useState, useEffect, useRef } from "react";
import { Search, FileWarning, ShieldCheck, ShieldAlert, ShieldX, Ban, Link2, Loader2, ChevronRight, ExternalLink, Stamp, MessageCircle, X } from "lucide-react";

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
const SUBJECT_BG = "#FBF8EF";
// Zone B (Taher, Nov 10): the pale sage was rejected — the journey now
// runs in one warm paper family: A light, B a noticeably darker shade
// of the same family, C back to the home paper tones.
const FINDINGS_BG = "#D8CBAF";
const SOURCES_BG = "#FBF8EF";

// Deeper-ink stamp palette ("Option B", Taher's final pick, Nov 6): dusty
// versions of the verdict colors pressed one shade deeper, so the stamp
// stands out from the paper without shouting. Used only by the InkStamp
// and its score bar underneath.
const STAMP_GREEN = "#3E5C4B";
const STAMP_SAGE = "#677D5F";
const STAMP_OCHRE = "#8A743F";
const STAMP_CLAY = "#96603F";
const STAMP_TERRA = "#8C4A3E";
const STAMP_GREY = "#5C564C";

const VERDICTS = {
  "Great Buy": { color: GREEN, stamp: STAMP_GREEN, label: "APPROVED", Icon: ShieldCheck, rotate: "-6deg" },
  "Decent": { color: AMBER, stamp: STAMP_OCHRE, label: "MIXED", Icon: ShieldAlert, rotate: "3deg" },
  "Skip It": { color: SLATE, stamp: STAMP_GREY, label: "SKIP", Icon: Ban, rotate: "-4deg" },
  "Avoid": { color: RUST, stamp: STAMP_TERRA, label: "AVOID", Icon: ShieldX, rotate: "5deg" },
};

const FACT_RATINGS = {
  "True": { color: GREEN, stamp: STAMP_GREEN, label: "TRUE", Icon: ShieldCheck, rotate: "-6deg" },
  "Mostly True": { color: GREEN, stamp: STAMP_SAGE, label: "MOSTLY TRUE", Icon: ShieldCheck, rotate: "3deg" },
  "Mixed": { color: AMBER, stamp: STAMP_OCHRE, label: "MIXED", Icon: ShieldAlert, rotate: "-4deg" },
  "Misleading": { color: RUST, stamp: STAMP_CLAY, label: "MISLEADING", Icon: ShieldAlert, rotate: "4deg" },
  "False": { color: RUST, stamp: STAMP_TERRA, label: "FALSE", Icon: ShieldX, rotate: "-5deg" },
  "Can't Verify": { color: SLATE, stamp: STAMP_GREY, label: "UNVERIFIED", Icon: FileWarning, rotate: "3deg" },
};

// Captions for the animated jury banner, by stage.
const JURY_CAPTIONS = {
  idle: ["THE JURY, DELIBERATING", "Reviewing the product against real customer reviews online — gathering the most reliable facts before you buy."],
  fetching: ["THE JURY IS SEATED", "Fetching the post…"],
  researching: ["THE JURY IS DELIBERATING", "Reviewing the evidence…"],
  "need-caption": ["THE JURY NEEDS THE TEXT", "One juror is asking for the caption."],
};

function extractShortcode(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^(www\.|m\.)/, "");
    if (!["instagram.com", "facebook.com", "fb.watch"].includes(host)) return null;
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

// Display guardrails for a quick scan. The full research stays intact for
// Ask the Jury; the page itself shows the shortest useful version, even
// when a cached verdict was written before these limits existed.
function compactText(value, maxWords = 40, maxSentences = 2) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentences = clean.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [clean];
  let text = sentences.slice(0, maxSentences).join(" ").trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    text = `${words.slice(0, maxWords).join(" ").replace(/[,;:]+$/, "")}…`;
  }
  return text;
}

function compactPoint(value, maxWords = 14) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return clean;
  return `${words.slice(0, maxWords).join(" ").replace(/[,;:]+$/, "")}…`;
}

// Stages the whole flow moves through. Only one thing renders below the
// link input at a time, driven off this.
// idle -> fetching -> (need-caption -> researching) | researching -> done
//                   \-> error (from any step)
// Owner bypass: a one-time visit to factjury.com/?owner=<token> stores
// the token on this device; every API call from this device then carries
// it, and the server exempts the owner from the daily limits. Nothing is
// shown in the UI, and other visitors never see or send it.
function ownerToken() {
  try {
    return window.localStorage.getItem("fj_owner") || null;
  } catch {
    return null;
  }
}
function ownerHeaders() {
  const t = ownerToken();
  return t ? { "x-owner-token": t } : {};
}

export default function FactChecker() {
  // Deep-link prefill: the iOS app's share sheet lands people on
  // factjury.com/?link=<shared post URL>. Pre-fill the search box with it
  // (product mode); the effect below then starts the check automatically.
  const [searchText, setSearchText] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("link")?.trim() || "";
    } catch {
      return "";
    }
  });
  const [mode, setMode] = useState("product"); // product | factcheck

  const [stage, setStage] = useState("idle"); // idle | fetching | need-caption | researching | done | error
  const [errorMessage, setErrorMessage] = useState("");
  const [manualCaption, setManualCaption] = useState("");
  const [clipboardNote, setClipboardNote] = useState("");
  const [research, setResearch] = useState(null);
  const [quick, setQuick] = useState(null); // preliminary verdict from /api/quick, shown while the full research runs
  const [prevPage, setPrevPage] = useState(null); // findings we came from via a "worth comparing to" tap

  const verdictMeta = research?.verdict_label ? VERDICTS[research.verdict_label] : null;
  const factMeta = research?.rating ? FACT_RATINGS[research.rating] : null;
  const quickVerdictMeta = quick?.verdict_label ? VERDICTS[quick.verdict_label] : null;
  const quickFactMeta = quick?.rating ? FACT_RATINGS[quick.rating] : null;

  function switchMode(next) {
    if (next === mode) return;
    setMode(next);
    setStage("idle");
    setResearch(null);
    setQuick(null);
    setPrevPage(null);
    setErrorMessage("");
    setManualCaption("");
    setClipboardNote("");
  }

  async function fetchCaption(postUrl) {
    const endpoint = `/api/oembed?url=${encodeURIComponent(postUrl)}`;
    const res = await fetch(endpoint);
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("The post lookup didn't respond properly — please try again in a moment.");
    }
    if (!res.ok) {
      const errMsg = typeof data?.error === "string" ? data.error : data?.error?.message;
      throw new Error(errMsg || `Post lookup returned ${res.status}`);
    }
    return (data.description && data.description.trim()) || (data.title && data.title.trim()) || "";
  }

  async function runResearch(payload, modeOverride) {
    const runMode = modeOverride ?? mode;
    setStage("researching");
    setQuick(null);

    // Fast preliminary verdict, fired in parallel with the full research
    // below: when it lands, a preliminary card appears while the jury is
    // still deliberating, and the full findings replace it. Best-effort —
    // any failure is silent and the flow behaves exactly as before.
    (async () => {
      try {
        const quickRes = await fetch("/api/quick", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...ownerHeaders() },
          body: JSON.stringify({ mode: runMode, ...payload }),
        });
        if (!quickRes.ok) return;
        const quickData = await quickRes.json();
        if (quickData && (quickData.verdict_label || quickData.rating)) {
          setQuick(quickData);
        }
      } catch {
        // silent — the full research is the source of truth
      }
    })();

    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ownerHeaders() },
        body: JSON.stringify({ mode: modeOverride ?? mode, ...payload }),
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
        const errMsg = typeof data?.error === "string" ? data.error : data?.error?.message;
        throw new Error(errMsg || `Research returned ${response.status}`);
      }
      let parsed = data;
      if (typeof data === "string") {
        parsed = JSON.parse(stripFences(data));
      }
      // The full result is the source of truth — it replaces the
      // preliminary card even where the two disagree.
      setResearch(parsed);
      setQuick(null);
      setStage("done");
    } catch (err) {
      setQuick(null);
      setStage("error");
      setErrorMessage(err.message || "Something went wrong while researching.");
    }
  }

  // One search bar, two kinds of input: an Instagram or Facebook link goes
  // through the fetch-the-post flow, anything else is treated as typed text
  // (a brand/product name, or a claim in fact-check mode).
  function looksLikeLink(text) {
    return (
      /^https?:\/\//i.test(text) ||
      /^www\./i.test(text) ||
      /instagram\.com\//i.test(text) ||
      /facebook\.com\//i.test(text) ||
      /fb\.watch\//i.test(text)
    );
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
    setQuick(null);
    setPrevPage(null);
    setManualCaption("");
    setClipboardNote("");

    const clean = extractShortcode(linkText);
    if (!clean) {
      setStage("error");
      setErrorMessage("Links need to be Instagram or Facebook posts. To check anything else, just type it instead.");
      return;
    }

    setStage("fetching");
    try {
      const caption = await fetchCaption(clean);
      if (caption) {
        await runResearch({ caption, link: clean });
      } else {
        setStage("need-caption");
      }
    } catch (err) {
      setStage("error");
      setErrorMessage(
        err.message?.includes("Failed to fetch")
          ? "Couldn't reach the post lookup — check your connection and try again."
          : err.message || "Couldn't fetch that post."
      );
    }
  }

  async function handleSearchBrand(name) {
    setErrorMessage("");
    setResearch(null);
    setQuick(null);
    setPrevPage(null);
    setManualCaption("");
    await runResearch({ query: name });
  }

  // Tapping a "worth comparing to" product opens Fact Jury's own findings
  // page for it (a fresh product check), keeping the current findings one
  // tap away via the back link.
  function openAlternative(alt) {
    if (!alt?.name || stage === "researching" || stage === "fetching") return;
    setPrevPage({
      research,
      mode,
      label: research?.product_name || research?.claim || "the previous check",
    });
    setMode("product");
    setErrorMessage("");
    setManualCaption("");
    setResearch(null);
    setQuick(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    runResearch({ query: alt.name }, "product");
  }

  function goBackToPrev() {
    if (!prevPage) return;
    setResearch(prevPage.research);
    setQuick(null);
    setMode(prevPage.mode);
    setStage("done");
    setErrorMessage("");
    setPrevPage(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleManualContinue() {
    if (!manualCaption.trim()) return;
    runResearch({ caption: manualCaption.trim() });
  }

  const busy = stage === "fetching" || stage === "researching";

  // Opened with ?link= (e.g. handed over by the Fact Jury app's share
  // extension): pre-fill the box and start the check automatically.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const owner = params.get("owner");
    if (owner) {
      try {
        window.localStorage.setItem("fj_owner", owner);
      } catch {
        // storage unavailable (private mode) — the visit still works,
        // the bypass just won't persist on this device
      }
      params.delete("owner");
      const qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
    const shared = params.get("link");
    if (shared && looksLikeLink(shared)) {
      setSearchText(shared);
      handleRun(/^https?:\/\//i.test(shared) ? shared : `https://${shared}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Which Reading illustration the verdict earns: celebration, outrage, or
  // the split-decision shrug.
  const juryMood = verdictMeta
    ? research.verdict_label === "Great Buy"
      ? "good"
      : research.verdict_label === "Decent"
        ? "neutral"
        : "bad"
    : factMeta
      ? ["True", "Mostly True"].includes(research.rating)
        ? "good"
        : ["Mixed", "Can't Verify"].includes(research.rating)
          ? "neutral"
          : "bad"
      : null;

  return (
    <div
      style={{ background: PAPER, color: INK, minHeight: "100dvh", fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
      className="w-full max-w-full overflow-x-clip"
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,500;8..60,700&display=swap');
        html, body, #root { width: 100%; max-width: 100%; overflow-x: clip; }
        body { margin: 0; }
        *, *::before, *::after { box-sizing: border-box; }
        img, svg { max-width: 100%; }
        .fj-label { color: #6B6459; }
        .fj-sub { color: #6B6459; }
        .fj-body-copy { font-size: 14px; line-height: 1.55; }
        input, textarea, select { font-size: 16px !important; }
        .fj-wrap-anywhere { overflow-wrap: anywhere; word-break: break-word; }
        .fj-zone { border: 1px solid #D9D4C6; padding: 16px; }
        @media (min-width: 640px) { .fj-zone { padding: 24px; } }
      `}</style>
      <InkFilterDefs />

      {/* Masthead */}
      <header className="border-b w-full overflow-x-clip" style={{ borderColor: PAPER_LINE }}>
        <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-7 flex items-center justify-between min-w-0">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <img src="/logo-mark.png" alt="Fact Jury logo" className="h-14 sm:h-20 w-auto block shrink-0" />
            <div className="min-w-0">
              <h1 style={{ fontFamily: "'Source Serif 4', Georgia, serif" }} className="text-2xl sm:text-3xl font-bold tracking-tight">
                Fact Jury
              </h1>
              <p className="fj-body-copy mt-1 opacity-80">Unbiased product reviews and fact-checks of what you see on social media.</p>
            </div>
          </div>
        </div>
      </header>

      <main className="w-full max-w-3xl mx-auto px-3 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-8 overflow-x-clip">
        {/* The jury banner: animated deliberation, in session from the
            moment the page loads until the findings take over */}
        {stage !== "done" && stage !== "error" && (
          <section className="w-full overflow-hidden border" style={{ background: PAPER, borderColor: PAPER_LINE }}>
            <img
              src="/jury/deliberation.gif"
              alt="The Fact Jury at work — taking notes and arguing over the evidence"
              className="w-full max-w-full h-auto block"
            />
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 px-3 py-2 min-w-0">
              <span className="text-[11px] font-semibold tracking-widest">{JURY_CAPTIONS[stage][0]}</span>
              <span className="text-[11px] opacity-70 fj-wrap-anywhere">{JURY_CAPTIONS[stage][1]}</span>
            </div>
          </section>
        )}

        {/* Exhibit A: intake */}
        <section className="fj-zone w-full min-w-0 overflow-x-clip" style={{ background: SUBJECT_BG }}>
          <SectionLabel index="A" title="The Subject" />
          <div className="mt-5 space-y-3 min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
              <span className={`text-xs tracking-wide ${mode === "product" ? "font-semibold" : "opacity-60"}`}>
                Product verdict
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={mode === "factcheck"}
                aria-label="Toggle between product verdict and fact-check a claim"
                onClick={() => switchMode(mode === "product" ? "factcheck" : "product")}
                disabled={busy}
                className="relative w-12 h-6 border shrink-0 disabled:opacity-60"
                style={{ borderColor: INK, background: "rgba(255,255,255,0.35)" }}
              >
                <span
                  className="absolute top-[2px] bottom-[2px] w-5 transition-all duration-200"
                  style={{ background: INK, left: mode === "product" ? "2px" : "calc(100% - 22px)" }}
                />
              </button>
              <span className={`text-xs tracking-wide ${mode === "factcheck" ? "font-semibold" : "opacity-60"}`}>
                Fact-check a claim
              </span>
            </div>
            {mode === "product" ? (
              <p className="fj-body-copy opacity-90">
                Paste an <strong>Instagram or Facebook ad link</strong>, or type a <strong>brand or product name</strong>,
                and we'll tell you if it's worth your money or time. Or if you wanted, switch modes and we'll
                fact-check the claim in any post.
              </p>
            ) : (
              <p className="fj-body-copy opacity-90">
                Paste a link to an <strong>Instagram or Facebook post</strong> where someone makes a claim — about an event, a
                health tip, anything — or <strong>type the claim</strong> itself. We'll check it against reliable
                sources and tell you if it's true.
              </p>
            )}
            <form
              className="flex flex-col sm:flex-row gap-2 w-full min-w-0"
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmit();
              }}
            >
              <div className="flex-1 min-w-0 w-full flex items-center border px-3" style={{ borderColor: INK, background: "#fff" }}>
                <Search size={16} className="opacity-50 shrink-0" />
                <input
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  maxLength={500}
                  disabled={busy}
                  className="w-full min-w-0 bg-transparent outline-none px-2 py-2.5 text-sm disabled:opacity-60"
                />
              </div>
              <button
                type="submit"
                disabled={busy || !searchText.trim()}
                className="px-4 py-2.5 sm:py-0 flex items-center justify-center gap-2 text-sm font-medium text-white disabled:opacity-60 shrink-0 w-full sm:w-auto"
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

            {/* Case facts: one line — sources, privacy, fairness */}
            <p
              className="text-xs sm:text-[13px] leading-relaxed border px-3 py-2.5 w-full fj-wrap-anywhere"
              style={{ borderColor: PAPER_LINE, background: "rgba(255,255,255,0.45)" }}
            >
              Every verdict cites its sources <span className="opacity-50">·</span> No account, nothing stored{" "}
              <span className="opacity-50">·</span> Claims and products judged, never people
            </p>

            {stage === "error" && (
              <p className="text-sm" style={{ color: RUST }}>
                {errorMessage}
              </p>
            )}
          </div>
        </section>

        {/* Homepage proof sections — shown only before a run starts, so the
            findings own the page once research begins */}
        {stage === "idle" && (
          <>
            <section className="fj-zone w-full min-w-0 overflow-x-clip" style={{ background: FINDINGS_BG }}>
              <SectionLabel index="B" title="What a Filing Looks Like" />
              <div className="mt-5 grid sm:grid-cols-[auto_1fr] gap-5 items-start min-w-0">
                <div className="flex flex-col items-center sm:items-start gap-3 shrink-0">
                  <InkStamp color={STAMP_OCHRE} rotate="3deg" label="MIXED" />
                  <div className="w-full min-w-[132px]">
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Worth-it score — 5/10</p>
                    <WorthBar score={5} color={STAMP_OCHRE} />
                  </div>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Product</p>
                    <p className="text-sm font-medium">TurboTax — the “free” tax filing</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Reasoning</p>
                    <p className="fj-body-copy">
                      Great software, slippery pricing. “Free” excludes most filers, and paywalls often appear
                      after you've entered your whole return.
                    </p>
                  </div>
                  <p className="text-xs opacity-60">9 sources · FTC order, 2024 · State AG settlement · Consumer Reports · +6</p>
                </div>
              </div>

              <div className="mt-7 grid sm:grid-cols-[auto_1fr] gap-5 items-start min-w-0">
                <InkStamp color={STAMP_CLAY} rotate="4deg" label="MISLEADING" />
                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">The claim</p>
                    <p className="text-sm font-medium leading-relaxed">“Celery juice detoxes your liver”</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">What the evidence shows</p>
                    <p className="fj-body-copy">
                      Your liver detoxes itself. Celery juice is fine to drink, but no evidence shows it
                      cleanses anything.
                    </p>
                  </div>
                  <p className="text-xs opacity-60">4 sources · NIH · Cleveland Clinic · Mayo Clinic · +1</p>
                </div>
              </div>
            </section>

            <section className="fj-zone w-full min-w-0 overflow-x-clip" style={{ background: SOURCES_BG }}>
              <SectionLabel index="C" title="How We Check" />
              <ol className="mt-4 fj-body-copy list-decimal list-inside space-y-1.5 opacity-90">
                <li>We research the open web, starting with official records and reputable reporting.</li>
                <li>Health claims are weighed against mainstream medical consensus.</li>
                <li>Every verdict links to sources you can open and check.</li>
              </ol>
              <div className="mt-5 border px-3 py-3" style={{ borderColor: PAPER_LINE, background: "rgba(255,255,255,0.45)" }}>
                <p className="text-xs font-semibold tracking-widest">WHY NOT JUST ASK AN AI CHAT?</p>
                <p className="fj-body-copy mt-2">
                  Fact Jury checks real customer reviews and reliable sources before you buy. Brand posts are
                  claims, not proof, and no brand can pay for a better verdict. A general AI chat may answer
                  from memory and show no sources.
                </p>
              </div>
            </section>
          </>
        )}

        {/* Exhibit B: fallback when the caption couldn't be auto-read */}
        {stage === "need-caption" && (
          <section className="fj-zone w-full min-w-0 overflow-x-clip" style={{ background: SUBJECT_BG }}>
            <SectionLabel index="B" title="One More Thing" />
            <div className="mt-5 space-y-3 min-w-0">
              <p className="fj-body-copy">
                That post's text couldn't be read automatically — it happens on some posts, especially private or
                friends-only ones. No problem, grab it yourself:
              </p>
              {mode === "factcheck" && (
                <p className="fj-body-copy" style={{ color: RUST }}>
                  Fact-checking a spoken claim? We can't hear the post's audio — if the claim was said out loud
                  rather than written in the caption, just type the claim itself in the box below instead.
                </p>
              )}
              <ol className="fj-body-copy list-decimal list-inside space-y-1 opacity-80">
                <li>Open the post (link below).</li>
                <li>Copy the caption text.</li>
                <li>Paste it in the box and hit Continue.</li>
              </ol>
              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={/^https?:\/\//i.test(searchText.trim()) ? searchText.trim() : `https://${searchText.trim()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium hover:underline flex items-center gap-1"
                  style={{ color: INK }}
                >
                  Open the post <ExternalLink size={12} />
                </a>
                <button
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      if (text) {
                        setManualCaption(text);
                        setClipboardNote("Caption pasted — hit Continue below.");
                      } else {
                        setClipboardNote("Your clipboard looks empty — copy the caption first, then paste.");
                      }
                    } catch {
                      setClipboardNote("Couldn't read the clipboard — tap the box below and paste manually instead.");
                    }
                  }}
                  className="text-xs font-medium hover:underline opacity-70 hover:opacity-100"
                >
                  Paste from clipboard
                </button>
              </div>
              {clipboardNote && (
                <p className="text-xs" style={{ color: RUST }}>
                  {clipboardNote}
                </p>
              )}
              <textarea
                autoFocus
                value={manualCaption}
                onChange={(e) => setManualCaption(e.target.value)}
                rows={4}
                placeholder={
                  mode === "factcheck"
                    ? "Paste the post's caption here — or type the claim as you heard it…"
                    : "Paste the post's caption here…"
                }
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

        {/* Preliminary verdict: the fast tier's stamp + one sentence,
            shown while the full research is still running. No score
            here — the score arrives only with the full verdict. The
            deliberation banner above stays up; the full findings
            replace this card when they land. */}
        {stage === "researching" && (quickVerdictMeta || quickFactMeta) && (
          <section className="fj-zone w-full min-w-0 overflow-x-clip" style={{ background: FINDINGS_BG }}>
            <SectionLabel index="B" title="The Findings" />
            <p className="mt-3 text-[11px] font-semibold tracking-widest" style={{ color: RUST }}>
              PRELIMINARY VERDICT
            </p>

            {quickVerdictMeta && (
              <div className="mt-4 grid sm:grid-cols-[auto_1fr] gap-5 items-start min-w-0">
                <div className="flex flex-col items-center sm:items-start gap-3 shrink-0">
                  <InkStamp color={quickVerdictMeta.stamp} rotate={quickVerdictMeta.rotate} label={quickVerdictMeta.label} />
                </div>

                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">First take</p>
                    <p className="fj-body-copy">{compactText(quick.one_sentence_summary, 26, 1)}</p>
                  </div>
                  <p className="text-xs opacity-60 flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" /> Full findings on the way…
                  </p>
                </div>
              </div>
            )}

            {quickFactMeta && (
              <div className="mt-4 grid sm:grid-cols-[auto_1fr] gap-5 items-start min-w-0">
                <InkStamp color={quickFactMeta.stamp} rotate={quickFactMeta.rotate} label={quickFactMeta.label} />

                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">First take</p>
                    <p className="fj-body-copy">{compactText(quick.one_sentence_summary, 26, 1)}</p>
                  </div>
                  <p className="text-xs opacity-60 flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" /> Full findings on the way…
                  </p>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Exhibit C: findings */}
        {stage === "done" && research && (verdictMeta || factMeta) && (
          <section className="fj-findings fj-zone w-full min-w-0 overflow-x-clip" style={{ background: FINDINGS_BG }}>
            <SectionLabel index="B" title="The Findings" />

            {prevPage && (
              <button
                type="button"
                onClick={goBackToPrev}
                className="mt-3 text-xs hover:underline inline-flex items-center gap-1"
                style={{ color: RUST }}
              >
                ← Back to {prevPage.label}
              </button>
            )}

            {juryMood && (
              <figure className="mt-5 border-2 w-full overflow-hidden" style={{ borderColor: INK, background: PAPER }}>
                <img
                  src={`/jury/reading-${juryMood}.gif`}
                  alt="The jury reads its verdict"
                  className="w-full max-w-full h-auto block"
                />
                <figcaption
                  className="px-3 py-2 border-t-2 text-[11px]"
                  style={{ borderColor: INK, background: "rgba(238,235,226,0.6)" }}
                >
                  <span className="font-semibold tracking-widest">THE JURY HAS REACHED A VERDICT</span>{" "}
                  <span className="fj-sub">
                    {juryMood === "good"
                      ? "They approve."
                      : juryMood === "bad"
                        ? "They do not approve."
                        : "A split decision — the fine print is below."}
                  </span>
                </figcaption>
              </figure>
            )}

            {verdictMeta && (
            <div className="mt-5 grid sm:grid-cols-[auto_1fr] gap-5 items-start min-w-0">
              <div className="flex flex-col items-center sm:items-start gap-3 shrink-0 w-full sm:w-auto">
                <InkStamp color={verdictMeta.stamp} rotate={verdictMeta.rotate} label={verdictMeta.label} />
                <div className="w-full max-w-[190px] sm:max-w-none sm:min-w-[132px]">
                  <p className="fj-label text-[11px] font-semibold uppercase tracking-[0.14em] mb-1.5">
                    Worth-it score — {research.worth_it_score}/10
                  </p>
                  <WorthBar score={research.worth_it_score} color={verdictMeta.stamp} />
                </div>
              </div>

              <div className="min-w-0">
                <p className="fj-label text-[11px] font-semibold uppercase tracking-[0.14em] mb-1.5">Product identified</p>
                <p style={{ fontFamily: "'Source Serif 4', Georgia, serif" }} className="text-xl font-semibold leading-snug fj-wrap-anywhere">{research.product_name}</p>
                {(() => {
                  const mainIsAmazon = (() => {
                    try {
                      return !!research.url && /amazon\./i.test(new URL(research.url).hostname);
                    } catch {
                      return false;
                    }
                  })();
                  if (!research.amazon_url && !research.url) return null;
                  return (
                    <>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {research.amazon_url && (
                          <a
                            href={research.amazon_url}
                            target="_blank"
                            rel="sponsored noopener noreferrer"
                            className="text-[11px] font-medium hover:underline inline-flex items-center gap-1"
                            style={{ color: INK }}
                          >
                            Amazon <ExternalLink size={10} className="opacity-50 shrink-0" />
                          </a>
                        )}
                        {research.url && !mainIsAmazon && (
                          <a
                            href={research.url}
                            target="_blank"
                            rel="sponsored noopener noreferrer"
                            className="text-[11px] font-medium hover:underline inline-flex items-center gap-1"
                            style={{ color: INK }}
                          >
                            Maker&rsquo;s site <ExternalLink size={10} className="opacity-50 shrink-0" />
                          </a>
                        )}
                      </div>
                      {!research?.alternatives?.length && research.amazon_associate && (
                        <p className="fj-sub text-[11px] mt-2">
                          Links may earn Fact Jury a commission at no cost to you. As an Amazon
                          Associate, Fact Jury earns from qualifying purchases.
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
            )}

            {verdictMeta && (research?.pros?.length > 0 || research?.cons?.length > 0) && (
              <div className="mt-7 grid sm:grid-cols-2 gap-5 min-w-0">
                {research?.pros?.length > 0 && (
                  <div className="min-w-0">
                    <p className="fj-label text-[11px] font-semibold uppercase tracking-[0.14em] mb-2">Pros</p>
                    <ul className="space-y-2">
                      {research.pros.slice(0, 3).map((point, i) => (
                        <li key={i} className="fj-body-copy flex gap-2 min-w-0">
                          <span className="shrink-0 font-bold" style={{ color: GREEN }}>+</span>
                          <span className="min-w-0">{compactPoint(point, 14)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {research?.cons?.length > 0 && (
                  <div className="min-w-0">
                    <p className="fj-label text-[11px] font-semibold uppercase tracking-[0.14em] mb-2">Cons</p>
                    <ul className="space-y-2">
                      {research.cons.slice(0, 3).map((point, i) => (
                        <li key={i} className="fj-body-copy flex gap-2 min-w-0">
                          <span className="shrink-0 font-bold" style={{ color: RUST }}>−</span>
                          <span className="min-w-0">{compactPoint(point, 14)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {verdictMeta && research?.summary && (
              <div className="mt-6">
                <p className="fj-label text-[11px] font-semibold uppercase tracking-[0.14em] mb-1.5">Bottom line</p>
                <p className="fj-body-copy">{compactText(research.summary, 40, 2)}</p>
              </div>
            )}

            {factMeta && (
              <div className="mt-5 grid sm:grid-cols-[auto_1fr] gap-5 items-start min-w-0">
                <div className="flex justify-center sm:justify-start">
                  <InkStamp color={factMeta.stamp} rotate={factMeta.rotate} label={factMeta.label} />
                </div>

                <div className="space-y-4 min-w-0">
                  <div>
                    <p className="fj-label text-[11px] font-semibold uppercase tracking-[0.14em] mb-1.5">The claim</p>
                    <p style={{ fontFamily: "'Source Serif 4', Georgia, serif" }} className="text-lg font-semibold leading-snug fj-wrap-anywhere">&ldquo;{compactPoint(research.claim, 30)}&rdquo;</p>
                  </div>

                  <div>
                    <p className="fj-label text-[11px] font-semibold uppercase tracking-[0.14em] mb-1.5">Bottom line</p>
                    <p className="fj-body-copy">{compactText(research.summary, 40, 2)}</p>
                  </div>
                </div>
              </div>
            )}

            {factMeta && research?.evidence?.length > 0 && (
              <div className="mt-7">
                <p className="fj-label text-[11px] font-semibold uppercase tracking-[0.14em] mb-2">Key evidence</p>
                <ul className="space-y-2">
                  {research.evidence.slice(0, 3).map((point, i) => (
                    <li key={i} className="fj-body-copy flex gap-2 min-w-0">
                      <ChevronRight size={14} className="shrink-0 mt-1 opacity-50" />
                      <span className="min-w-0">{compactPoint(point, 16)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {research?.alternatives?.length > 0 && (
              <div className="mt-7 min-w-0">
                <p className="fj-label text-[11px] font-semibold uppercase tracking-[0.14em] mb-1.5">Worth comparing to</p>
                <p className="fj-sub text-xs mb-3">
                  Ratings sit under each name. Card links: Amazon · Maker&rsquo;s site · Fact Jury verdict.
                </p>
                <ul className="space-y-3">
                  {research.alternatives.slice(0, 3).map((alt, i) => {
                    const altMeta = alt.verdict_label ? VERDICTS[alt.verdict_label] : null;
                    const altIsAmazon = (() => {
                      try {
                        return !!alt.url && /amazon\./i.test(new URL(alt.url).hostname);
                      } catch {
                        return false;
                      }
                    })();
                    return (
                    <li key={i} className="p-3 border w-full min-w-0 overflow-hidden" style={{ borderColor: PAPER_LINE, background: PAPER }}>
                      <div className="flex gap-3 min-w-0">
                        {alt.image_url && (
                          <img
                            src={alt.image_url}
                            alt={alt.name}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                            className="w-16 h-16 object-contain shrink-0 border self-start"
                            style={{ borderColor: PAPER_LINE, background: "#fff" }}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="fj-body-copy font-semibold fj-wrap-anywhere" style={{ color: INK, fontFamily: "'Source Serif 4', Georgia, serif" }}>
                            {alt.name}
                          </p>
                          {altMeta && (
                            <p className="mt-1 flex items-center gap-2">
                              <span
                                className="border px-1.5 py-0.5 text-[10px] font-bold tracking-widest"
                                style={{ color: altMeta.stamp, borderColor: altMeta.stamp }}
                              >
                                {altMeta.label}
                              </span>
                              {typeof alt.worth_it_score === "number" && (
                                <span className="text-[11px] opacity-60">{alt.worth_it_score}/10</span>
                              )}
                            </p>
                          )}
                          {alt.price_text && (
                            <p className="text-xs font-medium mt-0.5">Approx. {alt.price_text}</p>
                          )}
                          {(alt.blurb || alt.reason) && (
                            <p className="text-xs mt-0.5">{compactPoint(alt.blurb || alt.reason, 16)}</p>
                          )}
                        </div>
                      </div>
                      <div
                        className="mt-3 pt-2 border-t flex flex-wrap gap-x-4 gap-y-1"
                        style={{ borderColor: PAPER_LINE }}
                      >
                        {alt.amazon_url && (
                          <a
                            href={alt.amazon_url}
                            target="_blank"
                            rel="sponsored noopener noreferrer"
                            className="text-[11px] font-medium hover:underline inline-flex items-center gap-1"
                            style={{ color: INK }}
                          >
                            Amazon <ExternalLink size={10} className="opacity-50 shrink-0" />
                          </a>
                        )}
                        {alt.url && !altIsAmazon && (
                          <a
                            href={alt.url}
                            target="_blank"
                            rel="sponsored noopener noreferrer"
                            className="text-[11px] font-medium hover:underline inline-flex items-center gap-1"
                            style={{ color: INK }}
                          >
                            Maker&rsquo;s site <ExternalLink size={10} className="opacity-50 shrink-0" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => openAlternative(alt)}
                          className="text-[11px] font-medium hover:underline inline-flex items-center gap-1"
                          style={{ color: INK }}
                        >
                          Fact Jury verdict <ChevronRight size={10} className="opacity-50 shrink-0" />
                        </button>
                      </div>
                    </li>
                    );
                  })}
                </ul>
                <p className="fj-sub text-[11px] mt-3">
                  Links may earn Fact Jury a commission at no cost to you.
                </p>
                {research?.amazon_associate && (
                  <p className="fj-sub text-[11px] mt-1">
                    As an Amazon Associate, Fact Jury earns from qualifying purchases.
                  </p>
                )}
              </div>
            )}

            {verdictMeta && (
              <JuryChat key={`${research.product_name}-${research.worth_it_score}`} verdict={research} />
            )}
          </section>
        )}

        {stage === "done" && research?.sources?.length > 0 && (
          <section className="fj-zone w-full min-w-0 overflow-x-clip" style={{ background: SOURCES_BG }}>
            <SectionLabel index="C" title="Sources Consulted" />
            <ul className="mt-4 divide-y" style={{ borderColor: PAPER_LINE }}>
              {research.sources.slice(0, 6).map((s, i) => (
                <li key={i} className="py-3 flex items-start justify-between gap-3 min-w-0">
                  <div className="min-w-0 flex-1">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="fj-body-copy font-medium hover:underline fj-wrap-anywhere"
                      style={{ color: INK }}
                    >
                      {s.title}
                    </a>
                    {s.note && <p className="fj-sub text-xs mt-0.5">{compactPoint(s.note, 10)}</p>}
                  </div>
                  <ExternalLink size={14} className="opacity-40 mt-1 shrink-0" />
                </li>
              ))}
            </ul>
            {research.sources.length > 6 && (
              <p className="fj-sub text-xs mt-2">Showing the six most useful sources from this check.</p>
            )}
          </section>
        )}
      </main>

      <footer className="w-full max-w-3xl mx-auto px-4 sm:px-6 pb-10 pt-4 text-[11px] opacity-50 leading-relaxed border-t fj-wrap-anywhere" style={{ borderColor: PAPER_LINE }}>
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
    <div className="flex items-center gap-3 min-w-0">
      <span
        className="text-sm font-bold px-2 py-1 shrink-0"
        style={{ background: INK, color: PAPER }}
      >
        {index}
      </span>
      <h2 style={{ fontFamily: "'Source Serif 4', Georgia, serif" }} className="text-xl font-bold leading-tight">
        {title}
      </h2>
    </div>
  );
}

// "Inked & Aged" verdict stamp (Taher's pick, Nov 6): a worn rubber-stamp
// impression — mono word in a 3px rule whose edges are roughened by the
// inkRoughen SVG displacement filter, no icon. The worth-it score never
// sits inside the stamp; it prints underneath it.
function JuryChat({ verdict }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [amazonAssociate, setAmazonAssociate] = useState(false);
  const [open, setOpen] = useState(false);
  const listRef = useRef(null);
  const MAX_QUESTIONS = 10;
  const asked = messages.filter((m) => m.from === "user").length;

  // The conversation scrolls inside its own panel — the page never grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, open]);

  // While the chat takeover is open, the page behind it must not scroll,
  // and Escape closes it like any other full-screen dialog.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  async function send() {
    const q = input.trim();
    if (!q || sending || asked >= MAX_QUESTIONS) return;
    const next = [...messages, { from: "user", text: q }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ownerHeaders() },
        body: JSON.stringify({
          verdict,
          messages: next.map((m) => ({ role: m.from === "user" ? "user" : "assistant", content: m.text })),
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "The jury didn't answer — try again.");
      if (data?.amazon_associate) setAmazonAssociate(true);
      setMessages([...next, { from: "jury", text: data.reply }]);
    } catch (err) {
      setMessages([...next, { from: "jury", text: err?.message || "The jury didn't answer — try again." }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {/* In the verdict, the chat is just a short invitation + button, so
          the page stays the same length no matter how long the
          conversation gets. The chat itself lives in the panel below. */}
      <div className="mt-7 border p-4" style={{ borderColor: PAPER_LINE, background: PAPER }}>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] opacity-70 mb-1">Ask the jury</p>
        <p className="fj-body-copy opacity-90 mb-4">
          Ask how this fits your needs, or whether a competitor beats it. Answers use only the findings above.
        </p>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium"
          style={{ backgroundColor: INK, color: PAPER }}
        >
          <MessageCircle size={15} /> Chat with the jury
        </button>
      </div>

      {/* Floating bubble: stays in reach while the visitor scrolls the
          verdict, and reopens the conversation where they left it. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open the Ask the Jury chat"
          className="fixed bottom-4 right-3 sm:right-4 z-40 inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm font-medium shadow-lg max-w-[calc(100vw-24px)]"
          style={{ backgroundColor: INK, color: PAPER }}
        >
          <MessageCircle size={16} /> Ask the Jury
        </button>
      )}

      {/* Chat takeover: opens over the WHOLE page (Taher, Nov 10 — the
          old partial panel floating over the verdict was confusing to
          type into). Full viewport, its own scroll, a clear Close
          control; the conversation and behavior are unchanged. */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Ask the Jury about ${verdict.product_name}`}
          className="fixed inset-0 z-50 flex flex-col w-full overflow-hidden"
          style={{ backgroundColor: PAPER }}
        >
          <div className="w-full max-w-3xl mx-auto flex flex-col flex-1 min-h-0">
          <div
            className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 border-b shrink-0"
            style={{ borderColor: PAPER_LINE }}
          >
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide opacity-60">Ask the jury</p>
              <p className="text-sm font-medium fj-wrap-anywhere">{verdict.product_name}</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close the chat"
              className="inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold shrink-0"
              style={{ borderColor: INK, color: INK, background: "rgba(255,255,255,0.45)" }}
            >
              <X size={15} /> Close
            </button>
          </div>

          <div ref={listRef} className="overflow-y-auto px-4 sm:px-6 py-3 space-y-4 flex-1 min-h-0">
            {messages.length === 0 && (
              <p className="text-sm opacity-70 leading-relaxed">
                Ask anything about this verdict — whether it fits your needs, how it compares, or whether one of
                the alternatives above beats it.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i}>
                <p className="text-[11px] uppercase tracking-wide opacity-50 mb-0.5">
                  {m.from === "user" ? "You" : "The jury"}
                </p>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.text}</p>
              </div>
            ))}
            {sending && <p className="text-sm opacity-60">The jury is conferring…</p>}
          </div>

          <div className="px-4 sm:px-6 pb-4 pt-2 border-t shrink-0" style={{ borderColor: PAPER_LINE }}>
            {asked >= MAX_QUESTIONS ? (
              <p className="text-sm opacity-60 py-1">
                That's the end of this chat — run a new check any time from the search bar.
              </p>
            ) : (
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") send();
                  }}
                  aria-label="Ask the jury a question about this verdict"
                  className="flex-1 min-w-0 border px-3 py-2 text-sm bg-transparent outline-none"
                  style={{ borderColor: PAPER_LINE, color: INK }}
                />
                <button
                  onClick={send}
                  disabled={sending || !input.trim()}
                  className="px-4 py-2 text-sm font-medium disabled:opacity-40 shrink-0"
                  style={{ backgroundColor: INK, color: PAPER }}
                >
                  Ask
                </button>
              </div>
            )}
            {amazonAssociate && (
              <p className="text-[11px] opacity-50 mt-2">
                Links may earn Fact Jury a commission at no cost to you. As an Amazon Associate, Fact Jury earns
                from qualifying purchases.
              </p>
            )}
          </div>
          </div>
        </div>
      )}
    </>
  );
}
function InkStamp({ color, rotate, label }) {
  return (
    <div
      className="px-3 sm:px-4 py-2.5 text-center select-none shrink-0 max-w-full"
      style={{
        border: `3.2px solid ${color}`,
        color,
        boxShadow: "2px 3px 0 rgba(28,42,51,0.08)",
        transform: `rotate(${rotate})`,
        filter: "url(#inkRoughen)",
      }}
    >
      <div className="text-lg sm:text-xl font-bold tracking-[0.14em] sm:tracking-[0.18em] leading-none whitespace-nowrap">{label}</div>
    </div>
  );
}

function InkFilterDefs() {
  return (
    <svg aria-hidden="true" className="absolute w-0 h-0">
      <defs>
        <filter id="inkRoughen">
          <feTurbulence type="fractalNoise" baseFrequency="0.12" numOctaves="3" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" />
        </filter>
      </defs>
    </svg>
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
