"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { estimate, tracksFor, type PricedModel } from "@/lib/estimate";
import { leaksBrand } from "@/lib/scoring";

interface CatalogEntry extends PricedModel {
  label: string;
  provider: string;
}
interface ModelsResponse {
  models: CatalogEntry[];
  defaults: string[];
  extractor: PricedModel | null;
  hasKey: boolean;
  error?: string;
}
interface Q {
  text: string;
  intent: string;
}

const PROVIDERS = [
  { provider: "anthropic", label: "Claude" },
  { provider: "openai", label: "OpenAI" },
  { provider: "google", label: "Gemini" },
  { provider: "perplexity", label: "Perplexity" },
];

const splitList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const money = (x: number) => (x < 0.01 ? "<$0.01" : `$${x.toFixed(2)}`);

export default function NewRun() {
  const router = useRouter();
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [aliases, setAliases] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [count, setCount] = useState(10);
  const [questions, setQuestions] = useState<Q[] | null>(null);
  const [dropped, setDropped] = useState<{ text: string; reason: string }[]>([]);
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [slots, setSlots] = useState<{ provider: string; id: string; on: boolean }[]>([]);
  const [samples, setSamples] = useState(3);
  const [busy, setBusy] = useState<"questions" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d: ModelsResponse) => {
        setCatalog(d);
        if (d.error) return setError(`Couldn't load models from OpenRouter: ${d.error}`);
        setSlots(
          PROVIDERS.map((p) => ({
            provider: p.provider,
            id: d.defaults.find((id) => id.startsWith(p.provider + "/")) ?? d.models.find((m) => m.provider === p.provider)?.id ?? "",
            on: true,
          })),
        );
      })
      .catch((e) => setError(String(e)));
  }, []);

  const target = useMemo(() => ({ brand: brand.trim(), aliases: splitList(aliases) }), [brand, aliases]);
  const chosen = useMemo(
    () => slots.filter((s) => s.on && s.id).map((s) => catalog?.models.find((m) => m.id === s.id)).filter((m): m is CatalogEntry => !!m),
    [slots, catalog],
  );
  const leaks = useMemo(() => (questions ?? []).map((q) => (target.brand ? leaksBrand(q.text, target) : null)), [questions, target]);
  const validQuestions = (questions ?? []).filter((q, i) => q.text.trim().length >= 5 && !leaks[i]);
  const est = useMemo(
    () => estimate({ questions: validQuestions.length, samples, models: chosen, extractor: catalog?.extractor ?? null }),
    [validQuestions.length, samples, chosen, catalog],
  );
  const minutes = Math.max(1, Math.round((est.answerCalls * 14 + est.extractCalls * 3) / 4 / 60));

  async function draftQuestions(e?: React.FormEvent) {
    e?.preventDefault();
    if (!brand.trim() || !category.trim()) return setError("Fill in both the brand and the category.");
    setError(null);
    setBusy("questions");
    try {
      const res = await fetch("/api/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, aliases: splitList(aliases), category, count }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setQuestions(d.questions);
      setDropped(d.dropped ?? []);
    } catch (err) {
      setError(`Couldn't draft questions: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    if (leaks.some(Boolean)) return setError("Remove the brand name from the highlighted questions first.");
    setError(null);
    setBusy("run");
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand,
          aliases: splitList(aliases),
          category,
          competitors: splitList(competitors),
          questions: validQuestions,
          models: chosen.map((m) => m.id),
          samples,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      router.push(`/runs/${d.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  const update = (i: number, text: string) => setQuestions((qs) => qs!.map((q, j) => (j === i ? { ...q, text } : q)));
  const remove = (i: number) => setQuestions((qs) => qs!.filter((_, j) => j !== i));

  return (
    <div className="pb-10">
      {/* Hero sentence */}
      <form onSubmit={draftQuestions} className="pt-14 sm:pt-20 pb-10 reveal">
        <h1 className="display text-[40px] sm:text-[64px] max-w-5xl">
          Does AI recommend{" "}
          <input
            aria-label="Brand"
            className="blank is-brand"
            placeholder="your brand"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            autoFocus
            spellCheck={false}
          />{" "}
          when people ask about{" "}
          <input
            aria-label="Category (plural noun phrase)"
            className="blank"
            placeholder="note-taking apps"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          ?
        </h1>
        <div className="mt-8 grid gap-4 sm:grid-cols-[1fr_1fr_auto] items-end max-w-4xl">
          <label className="block">
            <span className="label">Also counts as the brand (optional, comma-separated)</span>
            <input className="field mt-1" placeholder="e.g. Google Docs, Google Drive" value={aliases} onChange={(e) => setAliases(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Competitors to track (optional)</span>
            <input className="field mt-1" placeholder="e.g. Evernote, Obsidian" value={competitors} onChange={(e) => setCompetitors(e.target.value)} />
          </label>
          <div className="flex items-end gap-3">
            <label className="block">
              <span className="label">Questions</span>
              <select className="field mt-1 w-20" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[3, 5, 8, 10].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary whitespace-nowrap" disabled={busy !== null || !brand.trim() || !category.trim()}>
              {busy === "questions" ? "Drafting…" : questions ? "Redraft questions" : "Draft questions"}
            </button>
          </div>
        </div>
        {catalog && !catalog.hasKey && (
          <p className="mt-4 text-sm text-danger">OPENROUTER_API_KEY is missing. Add it to .env.local and restart the dev server.</p>
        )}
      </form>

      {error && (
        <p role="alert" className="mb-6 text-sm text-danger">
          {error}
        </p>
      )}

      {questions && (
        <section className="rule-top pt-8 grid gap-10 lg:grid-cols-[1.35fr_1fr] reveal">
          {/* Questions */}
          <div>
            <h2 className="section-title">The questions</h2>
            <p className="section-kicker mt-1">
              Vendor-neutral buyer questions. None may name <span className="hl">{brand}</span> or its aliases. The generator never saw the brand, and every question is
              checked in code. Edit freely.
            </p>
            <ol className="mt-5 space-y-2">
              {questions.map((q, i) => (
                <li key={i} className="group grid grid-cols-[2rem_1fr_auto] gap-2 items-start">
                  <span className="num text-ink-3 pt-2 text-sm">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <textarea
                      rows={2}
                      className="field resize-none"
                      style={leaks[i] ? { borderColor: "var(--danger)" } : undefined}
                      value={q.text}
                      onChange={(e) => update(i, e.target.value)}
                    />
                    <div className="mt-1 flex gap-2 text-xs text-ink-3">
                      <span>{q.intent}</span>
                      {leaks[i] && <span className="text-danger">Names “{leaks[i]}”. This question will be excluded.</span>}
                    </div>
                  </div>
                  <button onClick={() => remove(i)} className="text-ink-3 hover:text-danger text-sm pt-2 px-1" aria-label={`Remove question ${i + 1}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ol>
            <button onClick={() => setQuestions((qs) => [...(qs ?? []), { text: "", intent: "Custom" }])} className="mt-3 text-sm link text-ink-2">
              Add a question
            </button>
            {dropped.length > 0 && (
              <details className="mt-4 text-xs text-ink-3">
                <summary className="cursor-pointer">{dropped.length} generated question(s) dropped by the validator</summary>
                <ul className="mt-2 space-y-1">
                  {dropped.map((d, i) => (
                    <li key={i}>
                      “{d.text}”: {d.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {/* Models + estimate */}
          <div className="lg:sticky lg:top-6 self-start">
            <h2 className="section-title">The models</h2>
            <p className="section-kicker mt-1">
              Each question runs on two tracks: <em>parametric</em> (the model answers from memory) and <em>web</em> (the same model with live search). Defaults are
              picked from OpenRouter&apos;s current catalog.
            </p>
            <div className="mt-5 divide-y divide-[var(--rule)] rule-top rule-bottom">
              {slots.map((s, i) => {
                const p = PROVIDERS.find((x) => x.provider === s.provider)!;
                const options = catalog?.models.filter((m) => m.provider === s.provider) ?? [];
                const m = options.find((o) => o.id === s.id);
                return (
                  <div key={s.provider} className="py-3 grid grid-cols-[auto_5.5rem_1fr] items-center gap-3">
                    <input
                      type="checkbox"
                      aria-label={`Include ${p.label}`}
                      checked={s.on}
                      onChange={(e) => setSlots((xs) => xs.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))}
                      className="h-4 w-4 accent-[var(--ink)]"
                    />
                    <span className="text-sm font-medium">{p.label}</span>
                    <div>
                      <select
                        className="field"
                        value={s.id}
                        disabled={!s.on}
                        onChange={(e) => setSlots((xs) => xs.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))}
                      >
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.id.split("/")[1]} · ${(o.promptPrice * 1e6).toFixed(2)}/${(o.completionPrice * 1e6).toFixed(2)} per M
                          </option>
                        ))}
                      </select>
                      {m?.webNative && <p className="mt-1 text-xs text-ink-3">Always searches the web, so it runs on the web track only.</p>}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-5 flex items-center gap-3">
              <label className="label" htmlFor="samples">
                Samples per question × model × track
              </label>
              <select id="samples" className="field w-20" value={samples} onChange={(e) => setSamples(Number(e.target.value))}>
                {[1, 2, 3, 5].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </div>

            <div className="mt-6 rule-top pt-5">
              <p className="text-sm text-ink-2">
                <span className="num text-ink">{est.answerCalls}</span> answers ({validQuestions.length} questions ×{" "}
                {chosen.reduce((a, m) => a + tracksFor(m).length, 0)} model-tracks × {samples}) plus <span className="num text-ink">{est.extractCalls}</span>{" "}
                extraction calls
              </p>
              <p className="mt-2 flex items-baseline gap-3">
                <span className="display text-[44px] whitespace-nowrap">≈ {money(est.cost)}</span>
                <span className="label">estimated · about {minutes} min at 4 concurrent requests</span>
              </p>
              <button className="btn btn-primary mt-4" onClick={run} disabled={busy !== null || !validQuestions.length || !chosen.length}>
                {busy === "run" ? "Starting…" : "Run the check"}
              </button>
              <p className="mt-2 text-xs text-ink-3">Identical requests are cached during development, so re-runs of the same battery are free.</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
