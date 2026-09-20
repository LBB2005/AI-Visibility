"use client";

import { useCallback, useEffect, useState } from "react";

interface Candidate {
  done: boolean;
  id: string;
  answerId: number;
  question: string;
  answer: string;
  model: string;
  track: string;
  sample: number;
  category: string;
  target: { brand: string; aliases: string[] };
  labeled: number;
  remaining: number;
}

interface Reveal {
  model: { brands: string[]; namesTarget: boolean };
  agreement: { binaryMatch: boolean; missing: string[]; extra: string[] };
  labeled: number;
}

/**
 * Blind labeling: the answer is shown as plain text with no brand highlighting, and the
 * extraction model's output never reaches the browser until a label has been submitted.
 * Both are deliberate — either one would anchor the judgement we're trying to validate.
 */
export default function GoldLabeler() {
  const [c, setC] = useState<Candidate | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [brands, setBrands] = useState("");
  const [listing, setListing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = useCallback(async () => {
    setReveal(null);
    setBrands("");
    setListing(false);
    setError(null);
    try {
      const res = await fetch("/api/gold", { cache: "no-store" });
      setC(await res.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Initial load sets state only once the fetch resolves, so it doesn't cascade renders.
  useEffect(() => {
    let alive = true;
    fetch("/api/gold", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => alive && setC(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const submit = useCallback(
    async (namesTarget: boolean) => {
      if (!c || busy || reveal) return;
      setBusy(true);
      try {
        const res = await fetch("/api/gold", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answerId: c.answerId,
            namesTarget,
            brands: listing && brands.trim() ? brands.split("\n").map((s) => s.trim()).filter(Boolean) : null,
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        setReveal(d);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [c, busy, reveal, listing, brands],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (reveal && (e.key === "Enter" || e.key === "n")) next();
      else if (!reveal && (e.key === "y" || e.key === "Y")) submit(true);
      else if (!reveal && (e.key === "n" || e.key === "N")) submit(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reveal, submit, next]);

  if (error) return <p className="pt-16 text-danger">{error}</p>;
  if (!c) return <p className="pt-16 text-ink-3">Loading…</p>;

  if (c.done) {
    return (
      <div className="pt-16 max-w-2xl">
        <h1 className="display text-[40px]">Every answer is labeled.</h1>
        <p className="mt-3 text-ink-2">
          {c.labeled} labels are in <span className="num">gold/extractor-gold.jsonl</span>. Run{" "}
          <span className="num">npm run gold:validate</span> to score the extractor and write the report.
        </p>
      </div>
    );
  }

  return (
    <div className="pt-10 pb-20 max-w-3xl">
      <div className="flex items-baseline justify-between">
        <h1 className="display text-[32px]">
          Does this answer name <mark className="hl">{c.target.brand}</mark>?
        </h1>
        <span className="label num">
          {c.labeled} labeled · {c.remaining} left
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-3">
        The extraction model&apos;s answer stays hidden until you submit, and the text below is unhighlighted on purpose.
      </p>

      <div className="mt-6 rule-top pt-4">
        <p className="label">
          {c.category} · {c.model} · {c.track === "web" ? "with web search" : "from memory"} · sample {c.sample}
        </p>
        <p className="mt-2 text-[16px]">{c.question}</p>
      </div>

      <div className="answer mt-4 rule-top pt-4 max-h-[55vh] overflow-y-auto">{c.answer}</div>

      {!reveal ? (
        <div className="mt-6 rule-top pt-5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--ink)]" checked={listing} onChange={(e) => setListing(e.target.checked)} />
            Also list every brand you see, in order (optional — used for precision and recall)
          </label>
          {listing && (
            <textarea
              className="field mt-2 h-28"
              placeholder={"One brand per line, in the order they first appear"}
              value={brands}
              onChange={(e) => setBrands(e.target.value)}
              autoFocus
            />
          )}
          <div className="mt-4 flex gap-3 items-center">
            <button className="btn btn-primary" onClick={() => submit(true)} disabled={busy}>
              Yes, it names {c.target.brand} <span className="text-xs opacity-70">(y)</span>
            </button>
            <button className="btn btn-ghost" onClick={() => submit(false)} disabled={busy}>
              No <span className="text-xs opacity-70">(n)</span>
            </button>
            <button className="text-sm link text-ink-3 ml-auto" onClick={next} disabled={busy}>
              Skip
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-6 rule-top pt-5">
          <p className="text-sm">
            {reveal.agreement.binaryMatch ? (
              <span className="chip chip-target">The extractor agreed</span>
            ) : (
              <span className="chip" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                The extractor disagreed — it said {reveal.model.namesTarget ? "named" : "not named"}
              </span>
            )}
          </p>
          <p className="mt-3 text-sm text-ink-2">
            It extracted: {reveal.model.brands.length ? reveal.model.brands.join(", ") : <span className="text-ink-3">nothing</span>}
          </p>
          {(reveal.agreement.missing.length > 0 || reveal.agreement.extra.length > 0) && (
            <p className="mt-2 text-sm text-ink-2">
              {reveal.agreement.missing.length > 0 && <>Missed: {reveal.agreement.missing.join(", ")}. </>}
              {reveal.agreement.extra.length > 0 && <>Extra: {reveal.agreement.extra.join(", ")}.</>}
            </p>
          )}
          <button className="btn btn-primary mt-4" onClick={next}>
            Next answer <span className="text-xs opacity-70">(enter)</span>
          </button>
        </div>
      )}
    </div>
  );
}
