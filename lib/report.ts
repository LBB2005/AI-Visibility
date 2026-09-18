import { db, getAnswers, getRun, type AnswerRow, type RunRow } from "./db";
import { isActive } from "./pipeline";
import { computeReport, trackInsight, verdict, type AnswerInput, type Report } from "./scoring";

export interface RowDTO {
  id: number;
  questionIdx: number;
  question: string;
  model: string;
  track: "parametric" | "web";
  sample: number;
  status: AnswerRow["status"];
  failedStage: string | null;
  error: string | null;
  answer: string | null;
  citations: { url: string; title?: string }[];
  ranked: { name: string; rank: number; isTarget: boolean }[];
  mentioned: boolean;
  rank: number | null;
  matchSource: "extraction" | "fallback" | null;
  cached: boolean;
  cost: number | null;
}

export interface Progress {
  total: number;
  ok: number;
  failed: number;
  pending: number;
  cost: number;
  active: boolean;
}

export interface RunPayload {
  run: RunRow;
  progress: Progress;
  report: Omit<Report, "scored">;
  verdict: string;
  trackInsight: string | null;
  rows?: RowDTO[];
}

const toInput = (a: AnswerRow): AnswerInput => ({
  questionIdx: a.question_idx,
  question: a.question,
  model: a.model,
  track: a.track,
  sample: a.sample,
  status: a.status === "ok" ? "ok" : "failed",
  answer: a.answer,
  brands: a.brands,
});

export function buildPayload(id: string, withRows: boolean): RunPayload | null {
  let run = getRun(id);
  if (!run) return null;
  // A "running" run with no worker in this process was cut off by a server restart.
  if (run.status === "running" && !isActive(id)) {
    db().prepare("UPDATE runs SET status = 'interrupted' WHERE id = ?").run(id);
    run = { ...run, status: "interrupted" };
  }
  const answers = getAnswers(id);
  const target = { brand: run.brand, aliases: run.aliases };
  // Pending rows are neither successes nor failures yet — score only finished rows.
  const finished = answers.filter((a) => a.status !== "pending");
  const { scored, ...report } = computeReport(finished.map(toInput), target, run.competitors);

  const progress: Progress = {
    total: answers.length,
    ok: answers.filter((a) => a.status === "ok").length,
    failed: answers.filter((a) => a.status === "failed").length,
    pending: answers.filter((a) => a.status === "pending").length,
    cost: answers.reduce((s, a) => s + (a.cost ?? 0), 0),
    active: isActive(id),
  };

  const payload: RunPayload = {
    run,
    progress,
    report,
    verdict: verdict({ ...report, scored }, run.brand),
    trackInsight: trackInsight({ ...report, scored }, run.brand),
  };

  if (withRows) {
    payload.rows = finished.map((a, i) => {
      const s = scored[i];
      return {
        id: a.id,
        questionIdx: a.question_idx,
        question: a.question,
        model: a.model,
        track: a.track,
        sample: a.sample,
        status: a.status,
        failedStage: a.failed_stage,
        error: a.error,
        answer: a.answer,
        citations: a.citations ?? [],
        ranked: s.ranked.map((r) => ({ name: r.name, rank: r.rank, isTarget: r.isTarget })),
        mentioned: s.mentioned,
        rank: s.rank,
        matchSource: s.matchSource,
        cached: !!a.cached,
        cost: a.cost,
      };
    });
  }
  return payload;
}
