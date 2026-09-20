/**
 * Extractor validation against a human-labeled gold set.
 * Pure: schema, id derivation, decision functions, and agreement math. File I/O
 * lives in ./goldStore so this module stays importable anywhere.
 */

import { z } from "zod";
import { brandKey, containsTerm, nameMatchesTarget } from "./match";
import { rankAnswer, type AnswerInput } from "./scoring";
import { cohensKappa, type Kappa } from "./stats";

export const GoldItemSchema = z.object({
  /** Content hash of the answer — stable even if the local database is wiped. */
  id: z.string().min(4),
  labeledAt: z.string(),
  labeler: z.string().default("human"),
  source: z.object({ runId: z.string(), answerId: z.number(), model: z.string(), track: z.string(), sample: z.number() }),
  target: z.object({ brand: z.string(), aliases: z.array(z.string()).default([]) }),
  question: z.string(),
  answer: z.string(),
  label: z.object({
    namesTarget: z.boolean(),
    /** Brands the human saw, in order. Null when the labeler skipped the list. */
    brands: z.array(z.string()).nullable().default(null),
    notes: z.string().optional(),
  }),
  model: z.object({
    extractor: z.string(),
    brands: z.array(z.object({ name: z.string(), first_position: z.number() })),
  }),
});

export type GoldItem = z.infer<typeof GoldItemSchema>;

/** FNV-1a over the answer text — short, stable, dependency-free. */
export function goldId(answer: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < answer.length; i++) {
    const c = answer.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")) + answer.length.toString(36);
}

const toInput = (it: GoldItem): AnswerInput => ({
  questionIdx: 0,
  question: it.question,
  model: it.source.model,
  track: it.source.track === "web" ? "web" : "parametric",
  sample: it.source.sample,
  status: "ok",
  answer: it.answer,
  brands: it.model.brands,
});

/** What the extraction model alone says: is the target among the names it returned? */
export const decideExtractionOnly = (it: GoldItem) => it.model.brands.some((b) => nameMatchesTarget(b.name, it.target));

/** What the product actually reports: extraction plus the raw-text fallback. */
export const decidePipeline = (it: GoldItem) => rankAnswer(toInput(it), it.target).mentioned;

export interface BinaryAgreement extends Kappa {
  /** Raw agreement, which (unlike kappa) doesn't collapse on an unbalanced sample. */
  accuracy: number;
  /** Prevalence-adjusted bias-adjusted kappa: 2·po − 1. */
  pabak: number | null;
  /** Share of gold items where the human said the brand is named. */
  prevalence: number;
  unbalanced: boolean;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export function binaryAgreement(items: GoldItem[], decide: (it: GoldItem) => boolean): BinaryAgreement {
  const human = items.map((it) => it.label.namesTarget);
  const machine = items.map(decide);
  const k = cohensKappa(machine, human);
  const { bothTrue: tp, aOnly: fp, bOnly: fn } = k.table;
  const prevalence = items.length ? human.filter(Boolean).length / items.length : 0;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return {
    ...k,
    accuracy: k.po,
    pabak: k.n ? 2 * k.po - 1 : null,
    prevalence,
    unbalanced: k.n > 0 && (prevalence < 0.2 || prevalence > 0.8),
    precision,
    recall,
    f1: precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null,
  };
}

/**
 * Greedy one-to-one match between two brand lists. Names match when their canonical
 * keys are equal or one contains the other as a whole word ("Microsoft OneNote" ↔ "OneNote").
 */
export function matchBrandSets(human: string[], machine: string[]): { tp: number; fp: number; fn: number; pairs: [string, string][] } {
  const left = [...human];
  const pairs: [string, string][] = [];
  const unmatched: string[] = [];
  for (const m of machine) {
    const i = left.findIndex((h) => brandKey(h) === brandKey(m) || containsTerm(h, m) || containsTerm(m, h));
    if (i >= 0) {
      pairs.push([left[i], m]);
      left.splice(i, 1);
    } else unmatched.push(m);
  }
  return { tp: pairs.length, fp: unmatched.length, fn: left.length, pairs };
}

export interface SetAgreement {
  items: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

/** Micro-averaged brand-set agreement over the items where the human listed brands. */
export function brandSetAgreement(items: GoldItem[]): SetAgreement {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let counted = 0;
  for (const it of items) {
    if (!it.label.brands) continue;
    counted++;
    const m = matchBrandSets(
      it.label.brands,
      it.model.brands.map((b) => b.name),
    );
    tp += m.tp;
    fp += m.fp;
    fn += m.fn;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return {
    items: counted,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null,
  };
}

export interface GoldEvaluation {
  items: number;
  pipeline: BinaryAgreement;
  extractionOnly: BinaryAgreement;
  sets: SetAgreement;
  /** Items where the pipeline and the human disagree — the list worth reading. */
  disagreements: { id: string; human: boolean; machine: boolean; question: string; excerpt: string }[];
}

export function evaluateGold(items: GoldItem[]): GoldEvaluation {
  return {
    items: items.length,
    pipeline: binaryAgreement(items, decidePipeline),
    extractionOnly: binaryAgreement(items, decideExtractionOnly),
    sets: brandSetAgreement(items),
    disagreements: items
      .filter((it) => decidePipeline(it) !== it.label.namesTarget)
      .map((it) => ({
        id: it.id,
        human: it.label.namesTarget,
        machine: decidePipeline(it),
        question: it.question,
        excerpt: it.answer.slice(0, 200).replace(/\s+/g, " "),
      })),
  };
}

const p2 = (x: number | null | undefined, digits = 3) => (x == null ? "—" : x.toFixed(digits));

/** The committed report at gold/validation.md. */
export function renderValidationReport(items: GoldItem[], ev: GoldEvaluation): string {
  const labelers = [...new Set(items.map((i) => i.labeler))].join(", ");
  const runs = [...new Set(items.map((i) => i.source.runId))].join(", ");
  const dates = items.map((i) => i.labeledAt).sort();
  const row = (name: string, a: BinaryAgreement) =>
    `| ${name} | ${p2(a.kappa)} | ${p2(a.pabak)} | ${p2(a.accuracy)} | ${p2(a.precision)} | ${p2(a.recall)} | ${p2(a.f1)} | ${a.table.aOnly} | ${a.table.bOnly} |`;

  return `# Extractor validation

Generated by \`npm run gold:validate\`. Do not edit by hand.

- **Items:** ${ev.items} (${ev.sets.items} with a full brand list)
- **Labelers:** ${labelers || "—"}
- **Labeled:** ${dates[0]?.slice(0, 10) ?? "—"} to ${dates[dates.length - 1]?.slice(0, 10) ?? "—"}
- **Source runs:** ${runs || "—"}
- **Prevalence** (human says the brand is named): ${p2(ev.pipeline.prevalence)}${ev.pipeline.unbalanced ? " — unbalanced, so read kappa next to raw agreement" : ""}

## Does the answer name the brand?

Agreement between the human label and the machine decision, on ${ev.items} answers.

| Decision | Cohen's κ | PABAK | Agreement | Precision | Recall | F1 | False positives | False negatives |
|---|---|---|---|---|---|---|---|---|
${row("Pipeline (extraction + text fallback)", ev.pipeline)}
${row("Extraction model alone", ev.extractionOnly)}

The pipeline row is what the app reports. The difference between the rows is what the raw-text fallback buys.

## Which brands were named?

Micro-averaged over ${ev.sets.items} items where the human listed every brand.

| Precision | Recall | F1 | TP | FP | FN |
|---|---|---|---|---|---|
| ${p2(ev.sets.precision)} | ${p2(ev.sets.recall)} | ${p2(ev.sets.f1)} | ${ev.sets.tp} | ${ev.sets.fp} | ${ev.sets.fn} |

## Disagreements

${
  ev.disagreements.length === 0
    ? "None — the pipeline matched the human on every labeled answer."
    : ev.disagreements
        .map((d) => `- **${d.id}** — human: ${d.human ? "named" : "not named"}, machine: ${d.machine ? "named" : "not named"}\n  - Q: ${d.question}\n  - A: ${d.excerpt}…`)
        .join("\n")
}
`;
}
