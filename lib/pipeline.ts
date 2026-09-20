import crypto from "node:crypto";
import { db, getRun, type Question, type RunModel } from "./db";
import { tracksFor } from "./estimate";
import { extractBrands } from "./extract";
import { chat } from "./openrouter";

/** Jobs (answer + extraction) in flight per run; the HTTP layer is separately capped at 4. */
const JOB_CONCURRENCY = 4;

const g = globalThis as unknown as { __avcActive?: Set<string> };
const active = (g.__avcActive ??= new Set<string>());

export const isActive = (id: string) => active.has(id);

export interface NewRun {
  brand: string;
  aliases: string[];
  category: string;
  competitors: string[];
  questions: Question[];
  models: RunModel[];
  samples: number;
  extractor: string;
  estCost: number | null;
  brandDomain?: string | null;
}

export function createRun(input: NewRun): string {
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  const d = db();
  const now = new Date().toISOString();
  const insertRun = d.prepare(
    `INSERT INTO runs (id, created_at, status, brand, aliases, category, competitors, questions, models, samples, extractor, est_cost, brand_domain)
     VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAnswer = d.prepare(
    `INSERT INTO answers (run_id, question_idx, question, model, track, sample, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  d.transaction(() => {
    insertRun.run(
      id,
      now,
      input.brand,
      JSON.stringify(input.aliases),
      input.category,
      JSON.stringify(input.competitors),
      JSON.stringify(input.questions),
      JSON.stringify(input.models),
      input.samples,
      input.extractor,
      input.estCost,
      input.brandDomain?.trim() || null,
    );
    input.questions.forEach((q, qi) => {
      const samples = Math.max(1, q.samples ?? input.samples);
      for (const m of input.models)
        for (const track of tracksFor(m))
          for (let s = 1; s <= samples; s++) insertAnswer.run(id, qi, q.text, m.id, track, s, now);
    });
  })();
  return id;
}

interface Job {
  id: number;
  question: string;
  model: string;
  track: "parametric" | "web";
  sample: number;
}

/**
 * Process every pending row of a run. Never throws: each failed call is recorded on its
 * row (stage + message) and excluded from metric denominators downstream.
 * Safe to call again to resume an interrupted run — only pending rows are processed.
 */
export async function processRun(runId: string): Promise<void> {
  if (active.has(runId)) return;
  active.add(runId);
  const d = db();
  try {
    const run = getRun(runId);
    if (!run) return;
    d.prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ?").run(runId);
    const webNative = new Set(run.models.filter((m) => m.webNative).map((m) => m.id));
    // Sample-major order so partial results are balanced across the whole grid.
    const jobs = d
      .prepare(`SELECT id, question, model, track, sample FROM answers WHERE run_id = ? AND status = 'pending' ORDER BY sample, question_idx, model, track`)
      .all(runId) as Job[];

    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await runJob(job, run.extractor, webNative.has(job.model));
      }
    };
    await Promise.all(Array.from({ length: Math.min(JOB_CONCURRENCY, jobs.length) }, worker));
    d.prepare("UPDATE runs SET status = 'done', finished_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
  } catch (e) {
    console.error(`[run ${runId}] aborted:`, e);
    d.prepare("UPDATE runs SET status = 'interrupted' WHERE id = ?").run(runId);
  } finally {
    active.delete(runId);
  }
}

async function runJob(job: Job, extractor: string, webNative: boolean) {
  const d = db();
  const now = () => new Date().toISOString();
  const fail = (stage: string, err: unknown, answer?: { text: string; citations: unknown; cost: number | null; latencyMs: number }) =>
    d
      .prepare(
        `UPDATE answers SET status = 'failed', failed_stage = ?, error = ?, answer = ?, citations = ?, cost = ?, latency_ms = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        stage,
        String((err as Error)?.message ?? err).slice(0, 1000),
        answer?.text ?? null,
        answer ? JSON.stringify(answer.citations) : null,
        answer?.cost ?? null,
        answer?.latencyMs ?? null,
        now(),
        job.id,
      );

  // 1) Answer: the question as a plain user message — no system prompt, no format
  //    instructions, provider-default sampling. Web track adds OpenRouter's web plugin,
  //    except for models that always search natively (Perplexity).
  let answer;
  try {
    answer = await chat(
      {
        model: job.model,
        messages: [{ role: "user", content: job.question }],
        ...(job.track === "web" && !webNative ? { plugins: [{ id: "web", max_results: 5 }] } : {}),
      },
      { cacheSalt: `sample:${job.sample}` },
    );
  } catch (e) {
    fail("answer", e);
    return;
  }

  // 2) Extraction: separate cheap call → strict JSON.
  try {
    const ex = await extractBrands(answer.text, extractor);
    d.prepare(
      `UPDATE answers SET status = 'ok', failed_stage = NULL, error = NULL, answer = ?, brands = ?, citations = ?, cost = ?, latency_ms = ?, cached = ?, updated_at = ? WHERE id = ?`,
    ).run(
      answer.text,
      JSON.stringify(ex.brands),
      JSON.stringify(answer.citations),
      (answer.cost ?? 0) + ex.cost,
      answer.latencyMs,
      answer.cached ? 1 : 0,
      now(),
      job.id,
    );
  } catch (e) {
    fail("extract", e, answer);
  }
}
