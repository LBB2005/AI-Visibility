"use client";

import type { RunModel } from "@/lib/db";
import { pct } from "@/lib/format";
import { cellKey, type SliceMetrics } from "@/lib/scoring";
import { ci, shortName } from "./shared";

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
