import { classifyDomain, resolveCitation } from "@/lib/citations";
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
    "target_mentioned", "target_rank", "match_source", "brands_ranked", "answer", "citations", "cited_domains", "own_domain_cited",
    "cost_usd", "cached",
  ];
  const lines = [header.join(",")];
  const ctx = { brandDomain: p.run.brand_domain, targetNames: [p.run.brand, ...p.run.aliases] };
  for (const r of p.rows ?? []) {
    const domains = [...new Set(r.citations.map((c) => resolveCitation(c)).filter((d): d is string => !!d))];
    const ownCited = domains.some((d) => classifyDomain(d, ctx) === "owned");
    lines.push(
      [
        p.run.id, r.questionIdx + 1, r.question, p.run.questions[r.questionIdx]?.intent ?? "", r.model, r.track, r.sample, r.status,
        r.failedStage ?? "", r.error ?? "", r.status === "ok" ? (r.mentioned ? 1 : 0) : "", r.rank ?? "", r.matchSource ?? "",
        r.ranked.map((b) => `${b.rank}. ${b.name}`).join("; "), r.answer ?? "", r.citations.map((c) => c.url).join(" "),
        domains.join(" "), r.citations.length ? (ownCited ? 1 : 0) : "",
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
