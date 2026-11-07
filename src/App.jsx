import React, { useState, useEffect } from "react";
import { Search, FileWarning, ShieldCheck, ShieldAlert, ShieldX, Ban, Link2, Loader2, ChevronRight, ExternalLink, Stamp } from "lucide-react";

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

// Faded-ink stamp palette (Taher's pick, Nov 6): washed, dusty versions of
// the verdict colors so the stamps sit quietly on the paper instead of
// shouting. Used only by the InkStamp and its score bar underneath.
const STAMP_GREEN = "#5A7D68";
const STAMP_SAGE = "#879A85";
const STAMP_OCHRE = "#A99868";
const STAMP_CLAY = "#AC856A";
const STAMP_TERRA = "#9E6B5E";
const STAMP_GREY = "#8A8378";

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
  const [prevPage, setPrevPage] = useState(null); // findings we came from via a "worth comparing to" tap

  const verdictMeta = research?.verdict_label ? VERDICTS[research.verdict_label] : null;
  const factMeta = research?.rating ? FACT_RATINGS[research.rating] : null;

  function switchMode(next) {
    if (next === mode) return;
    setMode(next);
    setStage("idle");
    setResearch(null);
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
    setStage("researching");
    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      setResearch(parsed);
      setStage("done");
    } catch (err) {
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
    window.scrollTo({ top: 0, behavior: "smooth" });
    runResearch({ query: alt.name }, "product");
  }

  function goBackToPrev() {
    if (!prevPage) return;
    setResearch(prevPage.research);
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
    const shared = new URLSearchParams(window.location.search).get("link");
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

            {juryMood && (
              <figure className="mt-4 border-2" style={{ borderColor: INK, background: PAPER }}>
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

              <div className="space-y-4">
                <div>
                  <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Product identified</p>
                  <p className="text-sm font-medium">{research.product_name}</p>
                </div>

                <div>
                  <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Reasoning</p>
                  <p className="text-sm leading-relaxed">{research.summary}</p>
                </div>
              </div>
            </div>
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
                <p className="text-xs opacity-60 mb-3">Tap one to see Fact Jury&rsquo;s rating of it.</p>
                <ul className="space-y-3">
                  {research.alternatives.map((alt, i) => (
                    <li key={i} className="p-3 border" style={{ borderColor: PAPER_LINE, background: "#fff" }}>
                      <button
                        type="button"
                        onClick={() => openAlternative(alt)}
                        className="text-sm font-medium hover:underline inline-flex items-center gap-1 text-left"
                        style={{ color: INK }}
                      >
                        {alt.name} <ChevronRight size={13} className="opacity-50" />
                      </button>
                      {alt.reason && <p className="text-xs opacity-70 mt-0.5">{alt.reason}</p>}
                      {alt.url && (
                        <a
                          href={alt.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] hover:underline inline-flex items-center gap-1 mt-1 opacity-60"
                        >
                          Maker&rsquo;s page <ExternalLink size={10} />
                        </a>
                      )}
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

// "Inked & Aged" verdict stamp (Taher's pick, Nov 6): a worn rubber-stamp
// impression — mono word in a 3px rule whose edges are roughened by the
// inkRoughen SVG displacement filter, no icon. The worth-it score never
// sits inside the stamp; it prints underneath it.
function InkStamp({ color, rotate, label }) {
  return (
    <div
      className="px-4 py-2.5 text-center select-none shrink-0"
      style={{
        border: `2.6px solid ${color}`,
        color,
        opacity: 0.88,
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
