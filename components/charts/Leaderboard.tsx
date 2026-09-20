"use client";

import { useState } from "react";
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { pct } from "@/lib/format";
import type { LeaderboardEntry } from "@/lib/scoring";
import { ci } from "./shared";

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
