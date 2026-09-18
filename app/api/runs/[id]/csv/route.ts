import { buildPayload } from "@/lib/report";

type Ctx = { params: Promise<{ id: string }> };

const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Raw rows: one line per (question × model × track × sample). */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = buildPayload(id, true);
  if (!p) return new Response("Run not found", { status: 404 });
  const header = [
    "run_id", "question_idx", "question", "intent", "model", "track", "sample", "status", "failed_stage", "error",
    "target_mentioned", "target_rank", "match_source", "brands_ranked", "answer", "citations", "cost_usd", "cached",
  ];
  const lines = [header.join(",")];
  for (const r of p.rows ?? []) {
    lines.push(
      [
        p.run.id, r.questionIdx + 1, r.question, p.run.questions[r.questionIdx]?.intent ?? "", r.model, r.track, r.sample, r.status,
        r.failedStage ?? "", r.error ?? "", r.status === "ok" ? (r.mentioned ? 1 : 0) : "", r.rank ?? "", r.matchSource ?? "",
        r.ranked.map((b) => `${b.rank}. ${b.name}`).join("; "), r.answer ?? "", r.citations.map((c) => c.url).join(" "),
        r.cost?.toFixed(6) ?? "", r.cached ? 1 : 0,
      ].map(cell).join(","),
    );
  }
  const slug = p.run.brand.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ai-visibility-${slug}-${p.run.id}.csv"`,
    },
  });
}
