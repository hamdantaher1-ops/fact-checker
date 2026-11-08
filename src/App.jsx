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
  "Skip It": { color: SLATE, stamp: STAMP_GREY, label: "PASS", Icon: Ban, rotate: "-4deg" },
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
    <div style={{ background: PAPER, color: INK, minHeight: "100%", fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }} className="w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,500;8..60,700&display=swap');
      `}</style>
      <InkFilterDefs />

      {/* Masthead */}
      <header className="border-b" style={{ borderColor: PAPER_LINE }}>
        <div className="max-w-3xl mx-auto px-6 py-7 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <img src="/logo-mark.png" alt="Fact Jury logo" className="h-20 w-auto block" />
            <div>
            <h1 style={{ fontFamily: "'Source Serif 4', Georgia, serif" }} className="text-3xl font-bold tracking-tight">
              Fact Jury
            </h1>
            <p className="text-xs mt-1 opacity-70">Unbiased product reviews and fact-checks of what you see on social media.</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* The jury banner: animated deliberation, in session from the
            moment the page loads until the findings take over */}
        {stage !== "done" && stage !== "error" && (
          <section style={{ background: PAPER }}>
            <img
              src="/jury/deliberation.gif"
              alt="The Fact Jury at work — taking notes and arguing over the evidence"
              className="w-full block"
            />
            <div
              className="flex flex-wrap justify-between gap-x-3 px-3 py-2"
            >
              <span className="text-[11px] font-semibold tracking-widest">{JURY_CAPTIONS[stage][0]}</span>
              <span className="text-[11px] opacity-70">{JURY_CAPTIONS[stage][1]}</span>
            </div>
          </section>
        )}

        {/* Exhibit A: intake */}
        <section>
          <SectionLabel index="A" title="The Subject" />
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-3">
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
              <p className="text-sm leading-relaxed opacity-80">
                Paste an <strong>Instagram or Facebook ad link</strong>, or type a <strong>brand or product name</strong>,
                and we'll tell you if it's worth your money or time. Or if you wanted, switch modes and we'll
                fact-check the claim in any post.
              </p>
            ) : (
              <p className="text-sm leading-relaxed opacity-80">
                Paste a link to an <strong>Instagram or Facebook post</strong> where someone makes a claim — about an event, a
                health tip, anything — or <strong>type the claim</strong> itself. We'll check it against reliable
                sources and tell you if it's true.
              </p>
            )}
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

            {/* Case facts: one line — sources, privacy, fairness */}
            <p
              className="text-xs sm:text-[13px] leading-relaxed border px-3 py-2.5"
              style={{ borderColor: PAPER_LINE, background: "rgba(255,255,255,0.35)" }}
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
            <section>
              <SectionLabel index="B" title="What a Filing Looks Like" />
              <div className="mt-4 grid sm:grid-cols-[auto_1fr] gap-6 items-start">
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
                    <p className="text-sm leading-relaxed">
                      Great software, slippery pricing. “Free” filing excludes most filers — the FTC ordered Intuit
                      to stop advertising it that way — and the paywalls tend to show up after you've typed in your
                      whole return.
                    </p>
                  </div>
                  <p className="text-xs opacity-60">9 sources · FTC order, 2024 · State AG settlement · Consumer Reports · +6</p>
                </div>
              </div>

              <div className="mt-8 grid sm:grid-cols-[auto_1fr] gap-6 items-start">
                <InkStamp color={STAMP_CLAY} rotate="4deg" label="MISLEADING" />
                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">The claim</p>
                    <p className="text-sm font-medium leading-relaxed">“Celery juice detoxes your liver”</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">What the evidence shows</p>
                    <p className="text-sm leading-relaxed">
                      Your liver detoxes itself — no juice required. Celery juice is a fine drink, but there's no
                      evidence it cleanses anything, and the posts selling it skip that part.
                    </p>
                  </div>
                  <p className="text-xs opacity-60">4 sources · NIH · Cleveland Clinic · Mayo Clinic · +1</p>
                </div>
              </div>
            </section>

            <section>
              <SectionLabel index="C" title="How We Check" />
              <ol className="mt-3 text-sm leading-relaxed list-decimal list-inside space-y-1.5 opacity-90">
                <li>We read the post, then research the open web — official records and reputable reporting first.</li>
                <li>For health claims, we weigh the mainstream medical consensus, not whoever posted loudest.</li>
                <li>An AI analyst weighs the evidence and files the verdict. Every claim in it links to a source you can open.</li>
              </ol>
              <div className="mt-5 border px-3 py-3" style={{ borderColor: PAPER_LINE, background: "rgba(255,255,255,0.35)" }}>
                <p className="text-xs font-semibold tracking-widest">WHY NOT JUST ASK AN AI CHAT?</p>
                <p className="text-sm leading-relaxed mt-2">
                  Fact Jury checks the product against real customer reviews online and gathers the most reliable
                  facts before you buy. Only credible sources count as evidence: official records, regulators,
                  independent testing, reputable reporting. Sponsored posts and brand marketing are claims to
                  check, never proof. No brand can pay for a better verdict. An AI chat does none of this — it
                  doesn't look anything up. It writes an answer from what it learned long ago, and when it doesn't
                  know something, it can just make it up. It can repeat ads and opinions as if they were facts,
                  and it sounds sure even when it's wrong. And it shows you no sources, so there's nothing you
                  can check.
                </p>
              </div>
            </section>
          </>
        )}

        {/* Exhibit B: fallback when the caption couldn't be auto-read */}
        {stage === "need-caption" && (
          <section>
            <SectionLabel index="B" title="One More Thing" />
            <div className="mt-4 space-y-3">
              <p className="text-sm leading-relaxed">
                That post's text couldn't be read automatically — it happens on some posts, especially private or
                friends-only ones. No problem, grab it yourself:
              </p>
              {mode === "factcheck" && (
                <p className="text-sm leading-relaxed" style={{ color: RUST }}>
                  Fact-checking a spoken claim? We can't hear the post's audio — if the claim was said out loud
                  rather than written in the caption, just type the claim itself in the box below instead.
                </p>
              )}
              <ol className="text-sm leading-relaxed list-decimal list-inside space-y-1 opacity-80">
                <li>Open the post (link below).</li>
                <li>Copy the caption text.</li>
                <li>Paste it in the box and hit Continue.</li>
              </ol>
              <div className="flex items-center gap-3">
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
          <section>
            <SectionLabel index="B" title="The Findings" />
            <p className="mt-3 text-[11px] font-semibold tracking-widest" style={{ color: RUST }}>
              PRELIMINARY VERDICT
            </p>

            {quickVerdictMeta && (
              <div className="mt-3 grid sm:grid-cols-[auto_1fr] gap-6 items-start">
                <div className="flex flex-col items-center sm:items-start gap-3 shrink-0">
                  <InkStamp color={quickVerdictMeta.stamp} rotate={quickVerdictMeta.rotate} label={quickVerdictMeta.label} />
                </div>

                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">First take</p>
                    <p className="text-sm leading-relaxed">{quick.one_sentence_summary}</p>
                  </div>
                  <p className="text-xs opacity-60 flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" /> Full findings on the way…
                  </p>
                </div>
              </div>
            )}

            {quickFactMeta && (
              <div className="mt-3 grid sm:grid-cols-[auto_1fr] gap-6 items-start">
                <InkStamp color={quickFactMeta.stamp} rotate={quickFactMeta.rotate} label={quickFactMeta.label} />

                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">First take</p>
                    <p className="text-sm leading-relaxed">{quick.one_sentence_summary}</p>
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
          <section>
            <SectionLabel index={stage === "need-caption" ? "C" : "B"} title="The Findings" />

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

            {verdictMeta && (
            <div className="mt-4 grid sm:grid-cols-[auto_1fr] gap-6 items-start">
              <div className="flex flex-col items-center sm:items-start gap-3 shrink-0">
                <InkStamp color={verdictMeta.stamp} rotate={verdictMeta.rotate} label={verdictMeta.label} />
                <div className="w-full min-w-[132px]">
                  <p className="text-xs uppercase tracking-wide opacity-60 mb-1">
                    Worth-it score — {research.worth_it_score}/10
                  </p>
                  <WorthBar score={research.worth_it_score} color={verdictMeta.stamp} />
                </div>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Product identified</p>
                <p className="text-sm font-medium">{research.product_name}</p>
              </div>
            </div>
            )}

            {verdictMeta && (research?.pros?.length > 0 || research?.cons?.length > 0) && (
              <div className="mt-8 grid sm:grid-cols-2 gap-6">
                {research?.pros?.length > 0 && (
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-2">Pros</p>
                    <ul className="space-y-2">
                      {research.pros.map((point, i) => (
                        <li key={i} className="text-sm leading-relaxed flex gap-2">
                          <span className="shrink-0 font-bold" style={{ color: GREEN }}>+</span>
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {research?.cons?.length > 0 && (
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-2">Cons</p>
                    <ul className="space-y-2">
                      {research.cons.map((point, i) => (
                        <li key={i} className="text-sm leading-relaxed flex gap-2">
                          <span className="shrink-0 font-bold" style={{ color: RUST }}>−</span>
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {verdictMeta && research?.summary && (
              <div className="mt-6">
                <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Reasoning</p>
                <p className="text-sm leading-relaxed">{research.summary}</p>
              </div>
            )}

            {juryMood && (
              <figure className="mt-8 border-2" style={{ borderColor: INK, background: PAPER }}>
                <img
                  src={`/jury/reading-${juryMood}.gif`}
                  alt="The jury reads its verdict"
                  className="w-full block"
                />
                <figcaption
                  className="px-3 py-2 border-t-2 text-[11px]"
                  style={{ borderColor: INK, background: "rgba(238,235,226,0.6)" }}
                >
                  <span className="font-semibold tracking-widest">THE JURY HAS REACHED A VERDICT</span>{" "}
                  <span className="opacity-70">
                    {juryMood === "good"
                      ? "They approve."
                      : juryMood === "bad"
                        ? "They do not approve."
                        : "A split decision — the fine print is below."}
                  </span>
                </figcaption>
              </figure>
            )}

            {factMeta && (
              <div className="mt-4 grid sm:grid-cols-[auto_1fr] gap-6 items-start">
                <InkStamp color={factMeta.stamp} rotate={factMeta.rotate} label={factMeta.label} />

                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">The claim</p>
                    <p className="text-sm font-medium leading-relaxed">&ldquo;{research.claim}&rdquo;</p>
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">What the evidence shows</p>
                    <p className="text-sm leading-relaxed">{research.summary}</p>
                  </div>
                </div>
              </div>
            )}

            {factMeta && research?.evidence?.length > 0 && (
              <div className="mt-8">
                <p className="text-xs uppercase tracking-wide opacity-60 mb-2">Key evidence</p>
                <ul className="space-y-2">
                  {research.evidence.map((point, i) => (
                    <li key={i} className="text-sm leading-relaxed flex gap-2">
                      <ChevronRight size={14} className="shrink-0 mt-1 opacity-50" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {research?.alternatives?.length > 0 && (
              <div className="mt-8">
                <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Worth comparing to</p>
                <p className="text-xs opacity-60 mb-3">
                  The jury&rsquo;s rating sits under each name. Tap an Amazon pick to buy it there — other picks open their full Fact Jury check.
                </p>
                <ul className="space-y-3">
                  {research.alternatives.map((alt, i) => {
                    const altMeta = alt.verdict_label ? VERDICTS[alt.verdict_label] : null;
                    const altIsAmazon = (() => {
                      try {
                        return !!alt.url && /amazon\./i.test(new URL(alt.url).hostname);
                      } catch {
                        return false;
                      }
                    })();
                    return (
                    <li key={i} className="p-3 border flex gap-3" style={{ borderColor: PAPER_LINE, background: "#fff" }}>
                      {alt.image_url &&
                        (alt.url ? (
                          <a href={alt.url} target="_blank" rel="sponsored noopener noreferrer" className="shrink-0 self-start">
                            <img
                              src={alt.image_url}
                              alt={alt.name}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                              }}
                              className="w-16 h-16 object-contain border"
                              style={{ borderColor: PAPER_LINE, background: "#fff" }}
                            />
                          </a>
                        ) : (
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
                        ))}
                      <div className="min-w-0">
                        {altIsAmazon ? (
                          <a
                            href={alt.url}
                            target="_blank"
                            rel="sponsored noopener noreferrer"
                            className="text-sm font-medium hover:underline inline-flex items-center gap-1 text-left"
                            style={{ color: INK }}
                          >
                            {alt.name} <ExternalLink size={12} className="opacity-50 shrink-0" />
                          </a>
                        ) : alt.url ? (
                          <button
                            type="button"
                            onClick={() => openAlternative(alt)}
                            className="text-sm font-medium hover:underline inline-flex items-center gap-1 text-left"
                            style={{ color: INK }}
                          >
                            {alt.name} <ChevronRight size={13} className="opacity-50 shrink-0" />
                          </button>
                        ) : (
                          <p className="text-sm font-medium" style={{ color: INK }}>
                            {alt.name}
                          </p>
                        )}
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
                        {alt.blurb && <p className="text-xs mt-0.5">{alt.blurb}</p>}
                        {alt.reason && <p className="text-xs opacity-70 mt-0.5">{alt.reason}</p>}
                        {altIsAmazon && (
                          <button
                            type="button"
                            onClick={() => openAlternative(alt)}
                            className="text-[11px] hover:underline inline-flex items-center gap-1 mt-1 opacity-60"
                            style={{ color: INK }}
                          >
                            See the full check <ChevronRight size={10} />
                          </button>
                        )}
                      </div>
                    </li>
                    );
                  })}
                </ul>
                <p className="text-[11px] opacity-50 mt-3">
                  Links may earn Fact Jury a commission at no cost to you.
                </p>
                {research?.amazon_associate && (
                  <p className="text-[11px] opacity-50 mt-1">
                    As an Amazon Associate, Fact Jury earns from qualifying purchases.
                  </p>
                )}
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

            {verdictMeta && (
              <JuryChat key={`${research.product_name}-${research.worth_it_score}`} verdict={research} />
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
      <div className="mt-10 pt-8 border-t" style={{ borderColor: PAPER_LINE }}>
        <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Ask the jury</p>
        <p className="text-sm opacity-80 mb-4">
          Questions about this verdict? Ask how it fits your needs — or whether a competitor beats it. Answers
          come only from the research above; nothing new is looked up.
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
          className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm font-medium shadow-lg"
          style={{ backgroundColor: INK, color: PAPER }}
        >
          <MessageCircle size={16} /> Ask the Jury
        </button>
      )}

      {/* Chat panel: fixed size, its own scroll — the page behind it
          doesn't move or grow. */}
      {open && (
        <div
          className="fixed inset-x-3 bottom-3 z-50 flex flex-col border shadow-2xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[380px]"
          style={{ backgroundColor: PAPER, borderColor: PAPER_LINE, maxHeight: "min(72vh, 580px)" }}
        >
          <div
            className="flex items-start justify-between gap-3 px-4 py-3 border-b shrink-0"
            style={{ borderColor: PAPER_LINE }}
          >
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide opacity-60">Ask the jury</p>
              <p className="text-sm font-medium truncate">{verdict.product_name}</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close the chat"
              className="p-1 opacity-60 hover:opacity-100 shrink-0"
              style={{ color: INK }}
            >
              <X size={16} />
            </button>
          </div>

          <div ref={listRef} className="overflow-y-auto px-4 py-3 space-y-4 flex-1">
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

          <div className="px-4 pb-3 pt-2 border-t shrink-0" style={{ borderColor: PAPER_LINE }}>
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
      )}
    </>
  );
}
function InkStamp({ color, rotate, label }) {
  return (
    <div
      className="px-4 py-2.5 text-center select-none shrink-0"
      style={{
        border: `3.2px solid ${color}`,
        color,
        boxShadow: "2px 3px 0 rgba(28,42,51,0.08)",
        transform: `rotate(${rotate})`,
        filter: "url(#inkRoughen)",
      }}
    >
      <div className="text-xl font-bold tracking-[0.18em] leading-none">{label}</div>
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
