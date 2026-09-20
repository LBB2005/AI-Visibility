"use client";

import type { RunModel } from "@/lib/db";
import { pct } from "@/lib/format";
import type { TrackGap } from "@/lib/scoring";
import { shortName } from "./shared";

// ---------------------------------------------------------------------------
// Track gap: dumbbell per model, memory (ring) → web (dot)
// ---------------------------------------------------------------------------

export function TrackGapChart({ gap, models }: { gap: TrackGap; models: RunModel[] }) {
  const rows = [
    ...gap.perModel.map((p) => ({ key: p.model, name: shortName(models.find((m) => m.id === p.model) ?? ({ id: p.model, label: p.model } as RunModel)), par: p.parametric, web: p.web, delta: p.delta, strong: false })),
    { key: "__all", name: "All paired models", par: gap.parametric, web: gap.web, delta: gap.delta, strong: true },
  ];
  const excluded = models.filter((m) => !gap.pairedModels.includes(m.id));
  return (
    <div>
      <div className="flex items-center gap-5 text-xs text-ink-3 mb-3">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--ink)] bg-[var(--paper)]" /> From memory
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full bg-[var(--ink)]" /> With web search
        </span>
      </div>
      <div className="space-y-1">
        {rows.map((r) => {
          const a = (r.par.rate ?? 0) * 100;
          const b = (r.web.rate ?? 0) * 100;
          const d = r.delta == null ? null : Math.round(r.delta * 100);
          return (
            <div key={r.key} className={`grid grid-cols-[minmax(120px,180px)_1fr_4.5rem] items-center gap-4 py-2 ${r.strong ? "rule-top mt-2 pt-3" : ""}`}>
              <div className={`text-sm ${r.strong ? "font-medium" : ""}`}>{r.name}</div>
              <div className="relative h-6" aria-label={`${r.name}: ${pct(r.par.rate)} from memory, ${pct(r.web.rate)} with web search`}>
                <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--rule)]" />
                {[0, 25, 50, 75, 100].map((t) => (
                  <div key={t} className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-[var(--rule-strong)]" style={{ left: `${t}%` }} />
                ))}
                <div className="absolute top-1/2 h-[3px] -translate-y-1/2 bg-[var(--ink)] opacity-40" style={{ left: `${Math.min(a, b)}%`, width: `${Math.abs(b - a)}%` }} />
                <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--ink)] bg-[var(--paper)]" style={{ left: `${a}%` }} title={`From memory: ${pct(r.par.rate)} (${r.par.mentions}/${r.par.n})`} />
                <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--ink)] ring-2 ring-[var(--paper)]" style={{ left: `${b}%` }} title={`With web: ${pct(r.web.rate)} (${r.web.mentions}/${r.web.n})`} />
              </div>
              <div className={`num text-right text-sm ${r.strong ? "font-medium" : "text-ink-2"}`}>{d == null ? "—" : `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} pts`}</div>
            </div>
          );
        })}
        <div className="grid grid-cols-[minmax(120px,180px)_1fr_4.5rem] gap-4 text-[11px] text-ink-3 num">
          <div />
          <div className="flex justify-between">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
          <div />
        </div>
      </div>
      {gap.bootstrap && (
        <p className="mt-4 text-xs text-ink-3">
          Question-clustered bootstrap of the gap: {pct(gap.bootstrap.delta, 1)} (95% CI {pct(gap.bootstrap.lo, 1)} to {pct(gap.bootstrap.hi, 1)}, p ={" "}
          {gap.bootstrap.p < 0.001 ? "<0.001" : gap.bootstrap.p.toFixed(3)}), resampling {gap.bootstrap.clusters} questions {gap.bootstrap.iterations} times.
          {gap.pValue !== null && ` A naive test that ignores clustering would report p = ${gap.pValue < 0.001 ? "<0.001" : gap.pValue.toFixed(3)}.`}
        </p>
      )}
      {excluded.length > 0 && (
        <p className="mt-3 text-xs text-ink-3">
          Excluded from the comparison: {excluded.map((m) => shortName(m)).join(", ")}. Only models that ran on both tracks are compared, so the gap isn&apos;t skewed by
          web-only models.
        </p>
      )}
    </div>
  );
}
