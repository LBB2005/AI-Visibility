"use client";

import { useMemo, useState } from "react";
import type { Question, RunModel } from "@/lib/db";
import type { RowDTO } from "@/lib/report";
import { CATEGORY_LABELS, classifyDomain, registrableDomain } from "@/lib/citations";
import { pct } from "@/lib/format";
import type { Target } from "@/lib/match";
import type { SliceMetrics } from "@/lib/scoring";
import { HighlightedText } from "./Highlight";

type Show = "all" | "named" | "missed" | "failed";

export default function Drilldown({
  rows,
  questions,
  models,
  byQuestion,
  target,
}: {
  rows: RowDTO[];
  questions: Question[];
  models: RunModel[];
  byQuestion: { questionIdx: number; metrics: SliceMetrics }[];
  target: Target;
}) {
  const [model, setModel] = useState("all");
  const [track, setTrack] = useState("all");
  const [show, setShow] = useState<Show>("all");

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (model === "all" || r.model === model) &&
          (track === "all" || r.track === track) &&
          (show === "all" ||
            (show === "named" && r.status === "ok" && r.mentioned) ||
            (show === "missed" && r.status === "ok" && !r.mentioned) ||
            (show === "failed" && r.status === "failed")),
      ),
    [rows, model, track, show],
  );

  const label = (id: string) => models.find((m) => m.id === id)?.label.split(" · ").slice(1).join(" · ") ?? id;

  return (
    <div>
      <div className="flex flex-wrap gap-3 items-center rule-bottom pb-4 mb-2">
        <select className="field w-auto" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Filter by model">
          <option value="all">All models</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {label(m.id)}
            </option>
          ))}
        </select>
        <select className="field w-auto" value={track} onChange={(e) => setTrack(e.target.value)} aria-label="Filter by track">
          <option value="all">Both tracks</option>
          <option value="parametric">From memory</option>
          <option value="web">With web search</option>
        </select>
        <div className="flex gap-1" role="group" aria-label="Filter answers">
          {(
            [
              ["all", "All"],
              ["named", `Names ${target.brand}`],
              ["missed", "Misses it"],
              ["failed", "Failed"],
            ] as [Show, string][]
          ).map(([k, l]) => (
            <button key={k} onClick={() => setShow(k)} className={`chip ${show === k ? "!border-[var(--ink)] !text-ink" : ""}`} aria-pressed={show === k}>
              {l}
            </button>
          ))}
        </div>
        <span className="label ml-auto">{filtered.length} answers</span>
      </div>

      <div>
        {questions.map((q, qi) => {
          const qs = filtered.filter((r) => r.questionIdx === qi);
          const m = byQuestion.find((b) => b.questionIdx === qi)?.metrics;
          if (!qs.length) return null;
          return (
            <details key={qi} className="rule-bottom group" open={qi === 0}>
              <summary className="cursor-pointer list-none py-4 grid grid-cols-[2.5rem_1fr_auto] gap-3 items-baseline">
                <span className="num text-ink-3 text-sm">Q{String(qi + 1).padStart(2, "0")}</span>
                <span>
                  <span className="text-[16px]">{q.text}</span>
                  <span className="block text-xs text-ink-3 mt-0.5">{q.intent}</span>
                </span>
                <span className="text-right">
                  <span className="num text-[18px]">{pct(m?.rate)}</span>
                  <span className="block text-[11px] text-ink-3 num">
                    {m ? `${m.mentions}/${m.n}` : ""} named
                  </span>
                </span>
              </summary>
              <div className="pb-6 pl-0 sm:pl-[3.25rem] space-y-5">
                {qs.map((r) => (
                  <AnswerBlock key={r.id} r={r} modelLabel={label(r.model)} target={target} />
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function AnswerBlock({ r, modelLabel, target }: { r: RowDTO; modelLabel: string; target: Target }) {
  const [open, setOpen] = useState(false);
  const long = (r.answer?.length ?? 0) > 700;
  return (
    <article className="rule-top pt-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{modelLabel}</span>
        <span className="text-ink-3">{r.track === "web" ? "with web search" : "from memory"}</span>
        <span className="text-ink-3 num">sample {r.sample}</span>
        <span className="ml-auto">
          {r.status === "failed" ? (
            <span className="text-danger text-xs">
              Failed at {r.failedStage}. Excluded from metrics.
            </span>
          ) : r.mentioned ? (
            <span className="chip chip-target num">
              #{r.rank} of {r.ranked.length}
              {r.matchSource === "fallback" ? " · text match" : ""}
            </span>
          ) : (
            <span className="chip">Not named</span>
          )}
        </span>
      </header>
      {r.status === "failed" && r.error && <p className="mt-2 text-xs text-danger num break-all">{r.error}</p>}
      {r.ranked.length > 0 && (
        <ol className="mt-3 flex flex-wrap gap-1.5">
          {r.ranked.map((b) => (
            <li key={b.rank} className={`chip ${b.isTarget ? "chip-target" : ""}`}>
              <span className="num opacity-70">{b.rank}</span> {b.name}
            </li>
          ))}
        </ol>
      )}
      {r.answer && (
        <>
          <div className={`answer mt-3 ${long && !open ? "clamped" : ""}`}>
            <HighlightedText text={r.answer} target={target} />
          </div>
          {long && (
            <button className="mt-2 text-xs link text-ink-2" onClick={() => setOpen((v) => !v)}>
              {open ? "Collapse" : "Show full answer"}
            </button>
          )}
        </>
      )}
      {r.citations.length > 0 && (
        <div className="mt-3 text-xs text-ink-3">
          Sources:{" "}
          {r.citations.slice(0, 8).map((c, i) => {
            const host = registrableDomain(c.url) ?? c.url;
            const category = classifyDomain(host, { targetNames: [target.brand, ...(target.aliases ?? [])] });
            return (
              <span key={c.url}>
                {i > 0 && ", "}
                <a className={`link ${category === "owned" ? "hl" : ""}`} href={c.url} target="_blank" rel="noreferrer noopener" title={CATEGORY_LABELS[category]}>
                  {host}
                </a>
              </span>
            );
          })}
        </div>
      )}
    </article>
  );
}
