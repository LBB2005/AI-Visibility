"use client";

import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RunModel } from "@/lib/db";
import { cellKey, pct, type LeaderboardEntry, type SliceMetrics, type TrackGap } from "@/lib/scoring";
import { useState } from "react";

const ci = (m: SliceMetrics | LeaderboardEntry) => (m.ci ? `${pct(m.ci[0])}–${pct(m.ci[1])}` : "—");
const shortName = (m: RunModel) => m.label.split(" · ").slice(1).join(" · ") || m.id;

// ---------------------------------------------------------------------------
// Model × track heatmap (sequential single-hue; yellow stays reserved for the brand)
// ---------------------------------------------------------------------------

function HeatCell({ m, label }: { m: SliceMetrics | undefined; label: string }) {
  if (!m || (m.n === 0 && m.failed === 0)) {
    return <div className="cell cell-na text-xs flex items-center">No data</div>;
  }
  const r = m.rate ?? 0;
  const bg = m.n ? `color-mix(in oklab, var(--heat-max) ${Math.round(8 + r * 92)}%, var(--heat-min))` : "var(--surface)";
  const fg = m.n && r > 0.45 ? "var(--paper)" : "var(--ink)";
  return (
    <div className="cell has-tip" tabIndex={0} style={{ background: bg, color: fg }} aria-label={`${label}: ${pct(m.rate)} mention rate`}>
      <div className="num text-[26px] leading-none">{pct(m.rate)}</div>
      <div className="num text-[11.5px] mt-2 opacity-80">{m.n ? `${m.mentions}/${m.n} · CI ${ci(m)}` : "all calls failed"}</div>
      {m.failed > 0 && <div className="text-[11px] mt-0.5 opacity-80">{m.failed} failed, excluded</div>}
      <div className="tip" role="tooltip">
        <div className="font-medium mb-1">{label}</div>
        <div>
          Named in {m.mentions} of {m.n} answers ({pct(m.rate, 1)})
        </div>
        <div>95% Wilson CI {ci(m)}</div>
        <div>Avg position when named: {m.avgPosition ? `#${m.avgPosition.toFixed(1)}` : "—"}</div>
        <div>Position-weighted share of voice: {pct(m.sov, 1)}</div>
        {m.failed > 0 && <div>{m.failed} failed call(s) excluded</div>}
      </div>
    </div>
  );
}

export function Heatmap({
  models,
  byModelTrack,
  byModel,
  byTrack,
}: {
  models: RunModel[];
  byModelTrack: Record<string, SliceMetrics>;
  byModel: Record<string, SliceMetrics>;
  byTrack: Record<"parametric" | "web", SliceMetrics>;
}) {
  return (
    <div className="overflow-x-auto -mx-1 px-1 pt-2">
      <div className="grid gap-2 min-w-[560px]" style={{ gridTemplateColumns: "minmax(150px, 1.2fr) repeat(3, minmax(120px, 1fr))" }}>
        <div />
        <div className="label self-end pb-1">From memory</div>
        <div className="label self-end pb-1">With web search</div>
        <div className="label self-end pb-1">Both tracks</div>
        {models.map((m) => (
          <Row key={m.id} m={m} byModelTrack={byModelTrack} byModel={byModel} />
        ))}
        <div className="self-center pt-2 text-sm font-medium">All models</div>
        <div className="pt-2">
          <HeatCell m={byTrack.parametric} label="All models · from memory" />
        </div>
        <div className="pt-2">
          <HeatCell m={byTrack.web} label="All models · with web search" />
        </div>
        <div className="pt-2" />
      </div>
    </div>
  );
}

function Row({ m, byModelTrack, byModel }: { m: RunModel; byModelTrack: Record<string, SliceMetrics>; byModel: Record<string, SliceMetrics> }) {
  return (
    <>
      <div className="self-center">
        <div className="text-sm font-medium">{shortName(m)}</div>
        <div className="text-[11.5px] text-ink-3 num">{m.id}</div>
      </div>
      {m.webNative ? (
        <div className="cell cell-na text-xs flex items-center leading-snug">No parametric track. This model always searches the web.</div>
      ) : (
        <HeatCell m={byModelTrack[cellKey(m.id, "parametric")]} label={`${shortName(m)} · from memory`} />
      )}
      <HeatCell m={byModelTrack[cellKey(m.id, "web")]} label={`${shortName(m)} · with web search`} />
      <HeatCell m={byModel[m.id]} label={`${shortName(m)} · both tracks`} />
    </>
  );
}

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
      {excluded.length > 0 && (
        <p className="mt-3 text-xs text-ink-3">
          Excluded from the comparison: {excluded.map((m) => shortName(m)).join(", ")}. Only models that ran on both tracks are compared, so the gap isn&apos;t skewed by
          web-only models.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Competitor leaderboard (Recharts horizontal bars). The target bar is highlighter yellow.
// ---------------------------------------------------------------------------

const TOP = 12;

export function Leaderboard({ entries, n }: { entries: LeaderboardEntry[]; n: number }) {
  const [asTable, setAsTable] = useState(false);
  const shown = entries.filter((e) => e.mentions > 0 || e.isTarget || e.isCompetitor);
  let data = shown.slice(0, TOP);
  const t = shown.find((e) => e.isTarget);
  if (t && !data.includes(t)) data = [...data, t];
  const height = data.length * 34 + 30;

  return (
    <div>
      <div className="flex justify-end mb-2">
        <button className="text-xs link text-ink-2" onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      </div>
      {asTable ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left label">
              <th className="font-normal py-1">Brand</th>
              <th className="font-normal text-right">Named in</th>
              <th className="font-normal text-right">Rate (95% CI)</th>
              <th className="font-normal text-right">Avg position</th>
              <th className="font-normal text-right">Share of voice</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.key} className="rule-top">
                <td className="py-1.5">{e.isTarget ? <span className="hl">{e.name}</span> : e.name}</td>
                <td className="num text-right">
                  {e.mentions}/{n}
                </td>
                <td className="num text-right">
                  {pct(e.rate)} <span className="text-ink-3">({ci(e)})</span>
                </td>
                <td className="num text-right">{e.avgPosition ? `#${e.avgPosition.toFixed(1)}` : "—"}</td>
                <td className="num text-right">{pct(e.sov, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={8}>
              <XAxis type="number" domain={[0, 1]} hide />
              <YAxis type="category" dataKey="name" width={150} tickLine={false} axisLine={false} interval={0} tick={<BrandTick data={data} />} />
              <Tooltip cursor={{ fill: "var(--rule)", opacity: 0.4 }} content={<LeaderTip n={n} />} />
              <Bar dataKey="rate" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {data.map((e) => (
                  <Cell key={e.key} fill={e.isTarget ? "var(--hl)" : "var(--bar)"} stroke={e.isTarget ? "var(--ink)" : "none"} strokeWidth={e.isTarget ? 1 : 0} />
                ))}
                <LabelList dataKey="rate" position="right" formatter={(v: unknown) => pct(Number(v) || 0)} style={{ fill: "var(--ink-2)", fontSize: 12, fontFamily: "var(--font-mono)" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {shown.length > data.length && !asTable && <p className="text-xs text-ink-3 mt-1">Showing the top {TOP}. The table lists all {shown.length} brands.</p>}
    </div>
  );
}

function BrandTick(props: { x?: number; y?: number; payload?: { value: string; index: number }; data: LeaderboardEntry[] }) {
  const { x = 0, y = 0, payload, data } = props;
  const e = data[payload?.index ?? 0];
  const name = String(payload?.value ?? "");
  const label = name.length > 20 ? name.slice(0, 19) + "…" : name;
  const w = label.length * 7.1 + 12;
  return (
    <g transform={`translate(${x},${y})`}>
      {e?.isTarget && <rect x={-w - 4} y={-11} width={w} height={22} rx={6} fill="var(--hl)" />}
      <text x={-10} dy={4} textAnchor="end" fontSize={13} fill={e?.isTarget ? "var(--hl-ink)" : "var(--ink)"} fontWeight={e?.isTarget ? 600 : 400}>
        {label}
      </text>
    </g>
  );
}

function LeaderTip({ active, payload, n }: { active?: boolean; payload?: { payload: LeaderboardEntry }[]; n: number }) {
  if (!active || !payload?.length) return null;
  const e = payload[0].payload;
  return (
    <div className="rounded-md px-3 py-2 text-[12.5px] leading-relaxed" style={{ background: "var(--ink)", color: "var(--paper)" }}>
      <div className="font-medium">{e.name}</div>
      <div>
        Named in {e.mentions} of {n} answers ({pct(e.rate, 1)})
      </div>
      <div>95% CI {ci(e)}</div>
      <div>Avg position {e.avgPosition ? `#${e.avgPosition.toFixed(1)}` : "—"}</div>
      <div>Share of voice {pct(e.sov, 1)}</div>
    </div>
  );
}
