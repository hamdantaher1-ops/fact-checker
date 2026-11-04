import React, { useState } from "react";
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

const VERDICTS = {
  "Great Buy": { color: GREEN, label: "APPROVED", Icon: ShieldCheck, rotate: "-6deg" },
  "Decent": { color: AMBER, label: "MIXED", Icon: ShieldAlert, rotate: "3deg" },
  "Skip It": { color: SLATE, label: "PASS", Icon: Ban, rotate: "-4deg" },
  "Avoid": { color: RUST, label: "AVOID", Icon: ShieldX, rotate: "5deg" },
};

const FACT_RATINGS = {
  "True": { color: GREEN, label: "TRUE", Icon: ShieldCheck, rotate: "-6deg" },
  "Mostly True": { color: GREEN, label: "MOSTLY TRUE", Icon: ShieldCheck, rotate: "3deg" },
  "Mixed": { color: AMBER, label: "MIXED", Icon: ShieldAlert, rotate: "-4deg" },
  "Misleading": { color: RUST, label: "MISLEADING", Icon: ShieldAlert, rotate: "4deg" },
  "False": { color: RUST, label: "FALSE", Icon: ShieldX, rotate: "-5deg" },
  "Can't Verify": { color: SLATE, label: "UNVERIFIED", Icon: FileWarning, rotate: "3deg" },
};

// Captions for the animated jury banner, by stage.
const JURY_CAPTIONS = {
  idle: ["THE JURY, DELIBERATING", "In session while you state your case."],
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
  const [searchText, setSearchText] = useState("");
  const [mode, setMode] = useState("product"); // product | factcheck

  const [stage, setStage] = useState("idle"); // idle | fetching | need-caption | researching | done | error
  const [errorMessage, setErrorMessage] = useState("");
  const [manualCaption, setManualCaption] = useState("");
  const [clipboardNote, setClipboardNote] = useState("");
  const [research, setResearch] = useState(null);

  const verdictMeta = research?.verdict_label ? VERDICTS[research.verdict_label] : null;
  const factMeta = research?.rating ? FACT_RATINGS[research.rating] : null;

  function switchMode(next) {
    if (next === mode) return;
    setMode(next);
    setStage("idle");
    setResearch(null);
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

  async function runResearch(payload) {
    setStage("researching");
    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, ...payload }),
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
        await runResearch({ caption });
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
    setManualCaption("");
    await runResearch({ query: name });
  }

  function handleManualContinue() {
    if (!manualCaption.trim()) return;
    runResearch({ caption: manualCaption.trim() });
  }

  const busy = stage === "fetching" || stage === "researching";

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

      {/* Masthead */}
      <header className="border-b" style={{ borderColor: PAPER_LINE }}>
        <div className="max-w-3xl mx-auto px-6 py-7 flex items-baseline justify-between">
          <div>
            <h1 style={{ fontFamily: "'Source Serif 4', Georgia, serif" }} className="text-3xl font-bold tracking-tight">
              Fact Jury
            </h1>
            <p className="text-xs mt-1 opacity-70">Unbiased product reviews and fact-checks of what you see on social media.</p>
          </div>
          <FileWarning size={28} strokeWidth={1.5} style={{ color: RUST }} />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Case facts: one line — sources, privacy, fairness */}
        <p
          className="text-xs sm:text-[13px] leading-relaxed border px-3 py-2.5"
          style={{ borderColor: PAPER_LINE, background: "rgba(255,255,255,0.35)" }}
        >
          Every verdict cites its sources <span className="opacity-50">·</span> No account, nothing stored{" "}
          <span className="opacity-50">·</span> Claims and products judged, never people
        </p>

        {/* The jury banner: animated deliberation, in session from the
            moment the page loads until the findings take over */}
        {stage !== "done" && stage !== "error" && (
          <section className="border-2 bg-white" style={{ borderColor: INK }}>
            <img
              src="/jury/deliberation.gif"
              alt="The Fact Jury at work — taking notes and arguing over the evidence"
              className="w-full block"
            />
            <div
              className="flex flex-wrap justify-between gap-x-3 px-3 py-2 border-t-2"
              style={{ borderColor: INK, background: "rgba(238,235,226,0.6)" }}
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
                Type a <strong>brand or product name</strong>, or paste a link to an{" "}
                <strong>Instagram or Facebook post</strong>. Either way, we'll research it and tell you if it's worth buying.
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
                <div
                  className="border-4 px-4 py-3 text-center select-none shrink-0 mx-auto sm:mx-0"
                  style={{ borderColor: AMBER, color: AMBER, transform: "rotate(3deg)" }}
                >
                  <ShieldAlert size={22} className="mx-auto mb-1" />
                  <div className="text-lg font-bold tracking-wider leading-none">MIXED</div>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Product</p>
                    <p className="text-sm font-medium">TurboTax — the “free” tax filing</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide opacity-60 mb-1">Worth-it score — 5/10</p>
                    <WorthBar score={5} color={AMBER} />
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
                <div
                  className="border-4 px-4 py-3 text-center select-none shrink-0 mx-auto sm:mx-0"
                  style={{ borderColor: RUST, color: RUST, transform: "rotate(4deg)" }}
                >
                  <ShieldAlert size={22} className="mx-auto mb-1" />
                  <div className="text-lg font-bold tracking-wider leading-none">MISLEADING</div>
                </div>
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
                  An AI chat answers from memory — ads, opinions, and invented details in one confident reply, with
                  nothing you can check. Fact Jury researches every verdict live, and only credible sources count
                  as evidence: official records, regulators, independent testing, reputable reporting. Sponsored
                  posts and brand marketing are claims to check, never proof. No brand can pay for a better verdict.
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

            {juryMood && (
              <figure className="mt-4 border-2 bg-white" style={{ borderColor: INK }}>
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
            )}

            {factMeta && (
              <div className="mt-4 grid sm:grid-cols-[auto_1fr] gap-6 items-start">
                <div
                  className="border-4 px-4 py-3 text-center select-none shrink-0 mx-auto sm:mx-0"
                  style={{
                    borderColor: factMeta.color,
                    color: factMeta.color,
                    transform: `rotate(${factMeta.rotate})`,
                  }}
                >
                  <factMeta.Icon size={22} className="mx-auto mb-1" />
                  <div className="text-lg font-bold tracking-wider leading-none">{factMeta.label}</div>
                </div>

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
                <p className="text-xs uppercase tracking-wide opacity-60 mb-2">Worth comparing to</p>
                <ul className="space-y-3">
                  {research.alternatives.map((alt, i) => (
                    <li key={i} className="p-3 border" style={{ borderColor: PAPER_LINE, background: "#fff" }}>
                      {alt.url ? (
                        <a
                          href={alt.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium hover:underline inline-flex items-center gap-1"
                          style={{ color: INK }}
                        >
                          {alt.name} <ExternalLink size={12} className="opacity-50" />
                        </a>
                      ) : (
                        <p className="text-sm font-medium">{alt.name}</p>
                      )}
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
