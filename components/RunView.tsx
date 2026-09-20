"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { RunPayload } from "@/lib/report";
import { pct } from "@/lib/format";
import { CitationSources, Heatmap, Leaderboard, TrackGapChart } from "./charts";
import Drilldown from "./Drilldown";
import { HighlightedText } from "./Highlight";

export default function RunView({ id }: { id: string }) {
  const [p, setP] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (withRows: boolean) => {
      const res = await fetch(`/api/runs/${id}${withRows ? "?rows=1" : ""}`, { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setP((prev) => (withRows || !prev?.rows ? d : { ...d, rows: prev.rows }));
      return d as RunPayload;
    },
    [id],
  );

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let tick = 0;
    const loop = async () => {
      try {
        // Every 5th poll pulls full rows so the drilldown fills in as answers land.
        const d = await load(tick++ % 5 === 0);
        if (stop) return;
        if (d.run.status === "running") timer = setTimeout(loop, 2000);
        else if (!d.rows) await load(true);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [load]);

  const act = async (action: "resume" | "retry-failed") => {
    await fetch(`/api/runs/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    window.location.reload();
  };

  if (error) return <p className="pt-16 text-danger">{error}</p>;
  if (!p) return <p className="pt-16 text-ink-3">Loading run…</p>;

  const { run, progress, report } = p;
  const target = { brand: run.brand, aliases: run.aliases };
  const done = progress.ok + progress.failed;
  const running = run.status === "running";
  const o = report.overall;
  const clustered = report.clustered?.overall;

  return (
    <div className="pb-16">
      {/* Header / verdict */}
      <section className="pt-10 sm:pt-14 reveal">
        <p className="label">
          {new Date(run.created_at).toLocaleString()} · {run.category} · {run.models.length} models · {run.questions.length} questions × {run.samples} sample
          {run.samples > 1 ? "s" : ""}
        </p>

        {running || run.status === "interrupted" ? (
          <div className="mt-5 max-w-3xl">
            <h1 className="display text-[40px] sm:text-[52px]">
              {running ? "Asking the models about " : "Paused while checking "}
              <mark className="hl hl-swipe">{run.brand}</mark>
              {running ? "…" : "."}
            </h1>
            <div className="mt-6 progress-track flex">
              <div className="progress-fill" style={{ width: `${(progress.ok / Math.max(1, progress.total)) * 100}%` }} />
              <div className="progress-fail" style={{ width: `${(progress.failed / Math.max(1, progress.total)) * 100}%` }} />
            </div>
            <p className="mt-2 text-sm text-ink-2 num">
              {done} / {progress.total} answers · {progress.failed} failed · ${progress.cost.toFixed(3)} spent
              {run.est_cost != null && ` of ~$${run.est_cost.toFixed(2)} estimated`}
            </p>
            {run.status === "interrupted" && (
              <p className="mt-4 text-sm">
                The server restarted before this run finished. {progress.pending} answers are still pending.{" "}
                <button className="btn btn-primary ml-2" onClick={() => act("resume")}>
                  Resume
                </button>
              </p>
            )}
            {o.n > 0 && <p className="mt-4 text-sm text-ink-3">Metrics below update as answers arrive.</p>}
          </div>
        ) : (
          <>
            <h1 className="display mt-4 text-[38px] sm:text-[56px] max-w-5xl">
              <HighlightedText text={p.verdict} target={{ brand: run.brand }} />
            </h1>
            {p.trackInsight && (
              <p className="mt-5 max-w-3xl border-l-2 border-[var(--hl)] pl-4 text-[17px] text-ink-2">
                <HighlightedText text={p.trackInsight} target={{ brand: run.brand }} />
              </p>
            )}
            {p.citationInsight && (
              <p className="mt-3 max-w-3xl border-l-2 border-[var(--rule-strong)] pl-4 text-[17px] text-ink-2">
                <HighlightedText text={p.citationInsight} target={{ brand: run.brand }} />
              </p>
            )}
          </>
        )}

        {/* Stat row */}
        {o.n > 0 && (
          <dl className="mt-10 grid grid-cols-2 md:grid-cols-4 rule-top rule-bottom">
            <Stat
              label="Mention rate"
              value={pct(o.rate)}
              sub={o.ci ? `95% CI ${pct(o.ci[0])}–${pct(o.ci[1])}` : ""}
              sub2={
                clustered?.rate
                  ? clustered.rate.degenerate
                    ? `identical across all ${clustered.rate.clusters} questions — too few to bound`
                    : `${pct(clustered.rate.lo)}–${pct(clustered.rate.hi)} clustered by question`
                  : undefined
              }
              first
            />
            <Stat label="Avg position when named" value={o.avgPosition ? `#${o.avgPosition.toFixed(1)}` : "—"} sub={`in ${o.mentions} answers`} />
            <Stat
              label="Share of voice"
              value={pct(o.sov, 1)}
              sub="position-weighted, 1/log₂(rank+1)"
              sub2={clustered?.sov && !clustered.sov.degenerate ? `${pct(clustered.sov.lo, 1)}–${pct(clustered.sov.hi, 1)} clustered` : undefined}
            />
            <Stat
              label="Answers counted"
              value={String(o.n)}
              sub={progress.failed ? `${progress.failed} failed calls excluded` : "no failed calls"}
              danger={progress.failed > 0}
            />
          </dl>
        )}

        {!running && (
          <div className="mt-5 flex flex-wrap gap-3 items-center">
            <a className="btn btn-ghost" href={`/api/runs/${id}/csv`}>
              Export raw rows (CSV)
            </a>
            {progress.failed > 0 && run.status === "done" && (
              <button className="btn btn-ghost" onClick={() => act("retry-failed")}>
                Retry {progress.failed} failed
              </button>
            )}
            {report.fallbackMatches > 0 && (
              <span className="text-xs text-ink-3">
                {report.fallbackMatches} mention(s) were found by the raw-text fallback after extraction missed them.
              </span>
            )}
            <Link href="/methods" className="text-sm link text-ink-2 ml-auto">
              How these numbers are computed
            </Link>
            <Link href="/" className="text-sm link text-ink-2">
              New check
            </Link>
          </div>
        )}
      </section>

      {o.n > 0 && (
        <>
          <Section title="Where it shows up" kicker="Mention rate by model and track. Hover a cell for the confidence interval, average position, and share of voice.">
            <Heatmap models={run.models} byModelTrack={report.byModelTrack} byModel={report.byModel} byTrack={report.byTrack} />
          </Section>

          {report.trackGap.pairedModels.length > 0 && (
            <Section
              title="Model memory vs. live web"
              kicker="The same model, the same question, with and without web search. A gap shows whether visibility comes from training data or from what's on the web right now."
            >
              <TrackGapChart gap={report.trackGap} models={run.models} />
            </Section>
          )}

          <Section title="Who gets recommended" kicker={`Every brand named across ${o.n} answers, ranked by mention rate. ${run.brand} is highlighted.`}>
            <Leaderboard entries={report.leaderboard} n={o.n} />
          </Section>

          {report.citations && (
            <Section
              title="Where the answers come from"
              kicker={`The sources models cited on the web track, and whether citing each one goes with ${run.brand} being recommended.`}
            >
              <CitationSources report={report.citations} brand={run.brand} />
            </Section>
          )}

          {p.rows && (
            <Section title="Every answer" kicker="Full answer text for each question, model, track, and sample. Brands are ranked by their first appearance in the text.">
              <Drilldown rows={p.rows} questions={run.questions} models={run.models} byQuestion={report.byQuestion} target={target} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  sub2,
  first,
  danger,
}: {
  label: string;
  value: string;
  sub: string;
  sub2?: string;
  first?: boolean;
  danger?: boolean;
}) {
  return (
    <div className={`py-5 pr-4 ${first ? "" : "md:pl-6 md:border-l border-[var(--rule)]"}`}>
      <dt className="label">{label}</dt>
      <dd className="display text-[44px] leading-none mt-2">{value}</dd>
      <dd className={`text-xs mt-2 ${danger ? "text-danger" : "text-ink-3"}`}>{sub}</dd>
      {sub2 && <dd className="text-xs mt-1 text-ink-3">{sub2}</dd>}
    </div>
  );
}

function Section({ title, kicker, children }: { title: string; kicker: string; children: React.ReactNode }) {
  return (
    <section className="mt-16 reveal">
      <h2 className="section-title">{title}</h2>
      <p className="section-kicker mt-1 mb-6">{kicker}</p>
      {children}
    </section>
  );
}
