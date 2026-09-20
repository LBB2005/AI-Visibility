import { describe, expect, it } from "vitest";
import {
  binaryAgreement,
  brandSetAgreement,
  decideExtractionOnly,
  decidePipeline,
  evaluateGold,
  goldId,
  matchBrandSets,
  renderValidationReport,
  type GoldItem,
} from "./gold";
import { loadGold, writeReport } from "./goldStore";

const item = (over: Partial<GoldItem> & { answer: string; namesTarget: boolean; machine: string[]; humanBrands?: string[] }): GoldItem => ({
  id: goldId(over.answer),
  labeledAt: "2026-09-20T00:00:00.000Z",
  labeler: "test",
  source: { runId: "r1", answerId: 1, model: "m", track: "web", sample: 1 },
  target: { brand: "Notion", aliases: [] },
  question: "What's the best note-taking app?",
  answer: over.answer,
  label: { namesTarget: over.namesTarget, brands: over.humanBrands ?? null },
  model: { extractor: "x", brands: over.machine.map((name, i) => ({ name, first_position: i + 1 })) },
});

describe("goldId", () => {
  it("is stable per answer text and differs between answers", () => {
    expect(goldId("hello")).toBe(goldId("hello"));
    expect(goldId("hello")).not.toBe(goldId("hello "));
  });
});

describe("decision functions", () => {
  const missedByExtractor = item({ answer: "Obsidian is great, though Notion is more flexible.", namesTarget: true, machine: ["Obsidian"] });

  it("separates the extraction model from the full pipeline", () => {
    expect(decideExtractionOnly(missedByExtractor)).toBe(false);
    // The raw-text fallback catches it, which is what the product reports.
    expect(decidePipeline(missedByExtractor)).toBe(true);
  });

  it("agrees when extraction names the brand", () => {
    const easy = item({ answer: "Notion first.", namesTarget: true, machine: ["Notion"] });
    expect(decideExtractionOnly(easy)).toBe(true);
    expect(decidePipeline(easy)).toBe(true);
  });
});

describe("binaryAgreement", () => {
  const items = [
    item({ answer: "Notion is best.", namesTarget: true, machine: ["Notion"] }),
    item({ answer: "Obsidian only.", namesTarget: false, machine: ["Obsidian"] }),
    // Human says the brand isn't really recommended here, machine extracted it → disagreement.
    item({ answer: "The notion of linked notes: Obsidian. Notion exists too.", namesTarget: false, machine: ["Obsidian", "Notion"] }),
  ];

  it("reports kappa next to raw agreement, prevalence and recall", () => {
    const a = binaryAgreement(items, decidePipeline);
    expect(a.n).toBe(3);
    expect(a.accuracy).toBeCloseTo(2 / 3, 6);
    expect(a.prevalence).toBeCloseTo(1 / 3, 6);
    expect(a.recall).toBe(1);
    expect(a.table).toMatchObject({ bothTrue: 1, aOnly: 1, bOnly: 0, bothFalse: 1 });
    expect(a.pabak).toBeCloseTo(1 / 3, 6);
  });

  it("flags an unbalanced gold set, where kappa alone misleads", () => {
    const skewed = Array.from({ length: 10 }, () => item({ answer: "Notion is best.", namesTarget: true, machine: ["Notion"] }));
    const a = binaryAgreement(skewed, decidePipeline);
    expect(a.accuracy).toBe(1);
    expect(a.unbalanced).toBe(true);
    expect(a.kappa).toBeNull(); // undefined when one label is constant — report accuracy instead
  });
});

describe("matchBrandSets", () => {
  it("matches name variants one-to-one", () => {
    const m = matchBrandSets(["OneNote", "Notion"], ["Microsoft OneNote", "Notion", "Craft"]);
    expect(m).toMatchObject({ tp: 2, fp: 1, fn: 0 });
  });
  it("counts what the human saw but the model missed", () => {
    expect(matchBrandSets(["Notion", "Bear"], ["Notion"])).toMatchObject({ tp: 1, fp: 0, fn: 1 });
  });
  it("scores brand sets only for items the human fully listed", () => {
    const withList = item({ answer: "Notion, Obsidian.", namesTarget: true, machine: ["Notion", "Obsidian"], humanBrands: ["Notion", "Obsidian"] });
    const withoutList = item({ answer: "Notion.", namesTarget: true, machine: ["Notion"] });
    const s = brandSetAgreement([withList, withoutList]);
    expect(s.items).toBe(1);
    expect(s.f1).toBe(1);
  });
});

describe("evaluateGold", () => {
  it("summarises both decisions and lists the disagreements", () => {
    const ev = evaluateGold([
      item({ answer: "Notion is best.", namesTarget: true, machine: ["Notion"] }),
      item({ answer: "Obsidian only.", namesTarget: true, machine: ["Obsidian"] }), // human says named, machine can't find it
    ]);
    expect(ev.items).toBe(2);
    expect(ev.disagreements).toHaveLength(1);
    expect(ev.disagreements[0].human).toBe(true);
    expect(renderValidationReport([], ev)).toContain("Extractor validation");
  });
});

// ---------------------------------------------------------------------------
// Regression gate: replays the committed gold set, if there is one.
// A fresh clone with no labels skips this block, so the suite still passes.
// ---------------------------------------------------------------------------

const GOLD = loadGold();
const MIN_KAPPA = 0.7;
const MIN_RECALL = 0.95;
const MIN_SET_F1 = 0.8;

describe.skipIf(GOLD.length === 0)(`extractor vs. ${GOLD.length} human-labeled answers`, () => {
  const ev = evaluateGold(GOLD);

  it(`matches human judgement (κ ≥ ${MIN_KAPPA} or agreement ≥ 0.95 when unbalanced)`, () => {
    const a = ev.pipeline;
    if (a.kappa === null || a.unbalanced) expect(a.accuracy).toBeGreaterThanOrEqual(0.95);
    else expect(a.kappa).toBeGreaterThanOrEqual(MIN_KAPPA);
  });

  it(`finds the brand when a human says it's there (recall ≥ ${MIN_RECALL})`, () => {
    expect(ev.pipeline.recall ?? 1).toBeGreaterThanOrEqual(MIN_RECALL);
  });

  it.skipIf(ev.sets.items === 0)(`extracts the right brand set (F1 ≥ ${MIN_SET_F1})`, () => {
    expect(ev.sets.f1 ?? 1).toBeGreaterThanOrEqual(MIN_SET_F1);
  });

  it.skipIf(!process.env.AVC_GOLD_REPORT)("writes gold/validation.md", () => {
    const path = writeReport(renderValidationReport(GOLD, ev));
    console.log(`\nWrote ${path}: κ=${ev.pipeline.kappa?.toFixed(3) ?? "n/a"} agreement=${ev.pipeline.accuracy.toFixed(3)} set F1=${ev.sets.f1?.toFixed(3) ?? "n/a"}`);
    expect(path).toContain("validation.md");
  });
});
