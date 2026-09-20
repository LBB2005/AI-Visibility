import { NextResponse } from "next/server";
import { z } from "zod";
import { listRuns } from "@/lib/db";
import { estimate } from "@/lib/estimate";
import { fetchCatalog, isWebNative, pickExtractor, toRunModel } from "@/lib/models";
import { createRun, processRun } from "@/lib/pipeline";
import { buildPayload } from "@/lib/report";
import { leaksBrand } from "@/lib/match";

const Body = z.object({
  brand: z.string().trim().min(1).max(100),
  aliases: z.array(z.string().trim()).default([]),
  category: z.string().trim().min(2).max(120),
  competitors: z.array(z.string().trim()).default([]),
  brandDomain: z.string().trim().max(200).optional(),
  questions: z.array(z.object({ text: z.string().trim().min(5).max(500), intent: z.string().default("Custom") })).min(1).max(30),
  models: z.array(z.string()).min(1).max(8),
  samples: z.number().int().min(1).max(10).default(3),
});

export async function GET() {
  const runs = listRuns().map((r) => {
    const p = buildPayload(r.id, false);
    return {
      id: r.id,
      created_at: r.created_at,
      status: p?.run.status ?? r.status,
      brand: r.brand,
      category: r.category,
      models: r.models.map((m) => m.label),
      questions: r.questions.length,
      samples: r.samples,
      rate: p?.report.overall.rate ?? null,
      n: p?.report.overall.n ?? 0,
      failed: p?.progress.failed ?? 0,
      pending: p?.progress.pending ?? 0,
      cost: p?.progress.cost ?? 0,
    };
  });
  return NextResponse.json({ runs });
}

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  const b = parsed.data;
  const aliases = b.aliases.filter(Boolean);
  const competitors = b.competitors.filter(Boolean);

  // Hard rule, enforced server-side too (questions may have been edited by hand).
  const target = { brand: b.brand, aliases };
  const leaks = b.questions.map((q, i) => ({ i, term: leaksBrand(q.text, target) })).filter((x) => x.term);
  if (leaks.length) {
    return NextResponse.json(
      { error: `Questions must not name the brand. Remove "${leaks[0].term}" from question ${leaks.map((l) => l.i + 1).join(", ")}.` },
      { status: 400 },
    );
  }

  const catalog = await fetchCatalog();
  const chosen = b.models.map((id) => catalog.find((m) => m.id === id)).filter((m) => !!m);
  if (chosen.length !== b.models.length) return NextResponse.json({ error: "Unknown model id." }, { status: 400 });
  const extractor = pickExtractor(catalog);
  if (!extractor) return NextResponse.json({ error: "No extraction model available." }, { status: 502 });

  const est = estimate({
    questions: b.questions.length,
    samples: b.samples,
    models: chosen.map((m) => ({ ...m, webNative: isWebNative(m.id) })),
    extractor: { ...extractor, webNative: false },
  });

  const id = createRun({
    brand: b.brand,
    aliases,
    category: b.category,
    competitors,
    questions: b.questions,
    models: chosen.map(toRunModel),
    samples: b.samples,
    extractor: extractor.id,
    estCost: est.cost,
    brandDomain: b.brandDomain,
  });
  void processRun(id); // background; progress is polled via GET /api/runs/[id]
  return NextResponse.json({ id });
}
