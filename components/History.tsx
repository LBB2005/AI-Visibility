"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { pct } from "@/lib/scoring";

interface RunSummary {
  id: string;
  created_at: string;
  status: string;
  brand: string;
  category: string;
  models: string[];
  questions: number;
  samples: number;
  rate: number | null;
  n: number;
  failed: number;
  pending: number;
  cost: number;
}

export default function History() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);

  const load = () =>
    fetch("/api/runs", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setRuns(d.runs));

  useEffect(() => {
    load();
  }, []);

  const del = async (id: string) => {
    if (!confirm("Delete this run and all its answers?")) return;
    await fetch(`/api/runs/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="pt-12 pb-16 reveal">
      <h1 className="display text-[48px]">History</h1>
      <p className="section-kicker mt-1">Every check is saved locally in SQLite (data/avc.db).</p>
      {!runs ? (
        <p className="mt-10 text-ink-3">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="mt-10 text-ink-2">
          No runs yet.{" "}
          <Link href="/" className="link">
            Start a check
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-8 rule-top">
          {runs.map((r) => (
            <li key={r.id} className="rule-bottom group">
              <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[9rem_1fr_7rem_auto] gap-x-6 gap-y-1 py-5 items-baseline">
                <span className="label num order-3 sm:order-none">{new Date(r.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                <Link href={`/runs/${r.id}`} className="block">
                  <span className="display text-[26px]">
                    <span className="hl">{r.brand}</span> <span className="text-ink-3">in</span> {r.category}
                  </span>
                  <span className="block text-xs text-ink-3 mt-1">
                    {r.models.join(" · ")} · {r.questions} questions × {r.samples}
                    {r.status !== "done" && <span className="text-danger"> · {r.status}{r.pending ? ` (${r.pending} pending)` : ""}</span>}
                    {r.failed > 0 && ` · ${r.failed} failed`} · ${r.cost.toFixed(2)}
                  </span>
                </Link>
                <span className="text-right">
                  <span className="num text-[28px]">{pct(r.rate)}</span>
                  <span className="block label">of {r.n} answers</span>
                </span>
                <button onClick={() => del(r.id)} className="text-xs text-ink-3 hover:text-danger opacity-0 group-hover:opacity-100 focus:opacity-100 order-4 sm:order-none" aria-label={`Delete run for ${r.brand}`}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
