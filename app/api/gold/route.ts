import { NextResponse } from "next/server";
import { z } from "zod";
import { db, parseAnswer, parseRun } from "@/lib/db";
import { decideExtractionOnly, goldId, matchBrandSets, type GoldItem } from "@/lib/gold";
import { appendGold, goldIds, loadGold } from "@/lib/goldStore";

type Raw = Record<string, unknown>;

/**
 * Candidate answers for labeling, joined with their run so we know the target brand.
 * Ordered by a hash of the row id: stable between requests, but mixed across models,
 * tracks and questions so the gold set isn't all one model's output.
 */
function candidates(runId?: string) {
  const sql = `SELECT a.*, r.brand, r.aliases, r.extractor, r.category
               FROM answers a JOIN runs r ON r.id = a.run_id
               WHERE a.status = 'ok' AND a.answer IS NOT NULL ${runId ? "AND a.run_id = ?" : ""}`;
  const rows = (runId ? db().prepare(sql).all(runId) : db().prepare(sql).all()) as Raw[];
  return rows
    .map((r) => ({ row: r, id: goldId(String(r.answer)) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Hands out one unlabeled answer. The model's extraction is deliberately NOT included. */
export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get("runId") ?? undefined;
  const labeled = goldIds();
  const pool = candidates(runId);
  const next = pool.find((c) => !labeled.has(c.id));
  const labeledHere = pool.filter((c) => labeled.has(c.id)).length;

  if (!next) {
    return NextResponse.json({ done: true, labeled: labeled.size, remaining: 0, candidates: pool.length });
  }
  const a = parseAnswer(next.row);
  const run = parseRun(next.row);
  return NextResponse.json({
    done: false,
    id: next.id,
    answerId: a.id,
    question: a.question,
    // The answer text only — no brands, no highlighting, nothing to anchor the labeler.
    answer: a.answer,
    model: a.model,
    track: a.track,
    sample: a.sample,
    category: run.category,
    target: { brand: run.brand, aliases: run.aliases },
    labeled: labeled.size,
    labeledHere,
    remaining: pool.length - labeledHere,
  });
}

const Body = z.object({
  answerId: z.number().int(),
  namesTarget: z.boolean(),
  brands: z.array(z.string().trim().min(1)).nullable().default(null),
  notes: z.string().trim().max(500).optional(),
  labeler: z.string().trim().max(60).default("human"),
});

/** Saves a label, then (and only then) reveals what the model said. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Bad request" }, { status: 400 });
  const b = parsed.data;

  const raw = db()
    .prepare(
      `SELECT a.*, r.brand, r.aliases, r.extractor FROM answers a JOIN runs r ON r.id = a.run_id WHERE a.id = ? AND a.status = 'ok'`,
    )
    .get(b.answerId) as Raw | undefined;
  if (!raw) return NextResponse.json({ error: "Answer not found" }, { status: 404 });

  const a = parseAnswer(raw);
  const run = parseRun(raw);
  const id = goldId(a.answer ?? "");
  if (goldIds().has(id)) return NextResponse.json({ error: "Already labeled" }, { status: 409 });

  const item: GoldItem = {
    id,
    labeledAt: new Date().toISOString(),
    labeler: b.labeler,
    source: { runId: a.run_id, answerId: a.id, model: a.model, track: a.track, sample: a.sample },
    target: { brand: run.brand, aliases: run.aliases },
    question: a.question,
    answer: a.answer ?? "",
    label: { namesTarget: b.namesTarget, brands: b.brands, notes: b.notes },
    model: { extractor: run.extractor, brands: a.brands ?? [] },
  };
  appendGold(item);

  const machineNames = item.model.brands.map((x) => x.name);
  const m = b.brands ? matchBrandSets(b.brands, machineNames) : null;
  return NextResponse.json({
    saved: true,
    labeled: loadGold().length,
    model: { brands: machineNames, namesTarget: decideExtractionOnly(item) },
    agreement: {
      binaryMatch: decideExtractionOnly(item) === b.namesTarget,
      missing: b.brands ? b.brands.filter((h) => !m!.pairs.some(([hh]) => hh === h)) : [],
      extra: b.brands ? machineNames.filter((n) => !m!.pairs.some(([, mm]) => mm === n)) : [],
    },
  });
}
