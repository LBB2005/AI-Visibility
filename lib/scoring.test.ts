import { describe, expect, it } from "vitest";
import {
  type AnswerInput,
  verdict,
  trackInsight,
  computeReport,
  containsTerm,
  fallbackOccurrences,
  fold,
  highlightSpans,
  leaksBrand,
  nameMatchesTarget,
  positionWeight,
  rankAnswer,
  sliceMetrics,
  twoProportionP,
  wilson,
} from "./scoring";

const notion = { brand: "Notion" };
const row = (answer: string, brands: string[], extra: Partial<AnswerInput> = {}): AnswerInput => ({
  questionIdx: 0,
  question: "q",
  model: "m1",
  track: "parametric",
  sample: 1,
  status: "ok",
  answer,
  brands: brands.map((name, i) => ({ name, first_position: i + 1 })),
  ...extra,
});

describe("fold", () => {
  it("preserves length so offsets map back to the raw text", () => {
    const s = "Café’s  Notion—great";
    expect(fold(s).length).toBe(s.length);
    expect(fold(s)).toBe("cafe's  notion-great");
  });
});

describe("containsTerm (word-boundary, case-insensitive)", () => {
  it("Notion vs Notion AI", () => {
    expect(containsTerm("Notion AI", "Notion")).toBe(true);
    expect(containsTerm("Notion", "Notion AI")).toBe(false);
    expect(containsTerm("notion ai", "Notion AI")).toBe(true);
  });
  it("does not match inside other words", () => {
    expect(containsTerm("Dropbox", "Box")).toBe(false);
    expect(containsTerm("Notional value", "Notion")).toBe(false);
    expect(containsTerm("Box", "Box")).toBe(true);
  });
  it("handles possessives, punctuation, markdown, diacritics", () => {
    expect(containsTerm("Notion's database", "Notion")).toBe(true);
    expect(containsTerm("**Notion**", "Notion")).toBe(true);
    expect(containsTerm("Trader Joe’s", "Trader Joe's")).toBe(true);
    expect(containsTerm("Crème app", "Creme")).toBe(true);
    expect(containsTerm("try monday.com today", "monday.com")).toBe(true);
    expect(containsTerm("try mondayXcom today", "monday.com")).toBe(false);
  });
  it("treats space and hyphen runs as equivalent inside multi-word names", () => {
    expect(containsTerm("Google  Docs", "Google Docs")).toBe(true);
    expect(containsTerm("Google-Docs", "Google Docs")).toBe(true);
    expect(containsTerm("GoogleDocs", "Google Docs")).toBe(false);
  });
});

describe("nameMatchesTarget with aliases", () => {
  const gw = { brand: "Google Workspace", aliases: ["Google Docs", "  "] };
  it("matches brand or any alias, ignores blank aliases", () => {
    expect(nameMatchesTarget("Google Docs", gw)).toBe(true);
    expect(nameMatchesTarget("google workspace", gw)).toBe(true);
    expect(nameMatchesTarget("Google Sheets", gw)).toBe(false);
    expect(nameMatchesTarget("Microsoft Word", gw)).toBe(false);
  });
});

describe("fallbackOccurrences (raw text)", () => {
  it("rejects the common word 'notion' but accepts the brand", () => {
    expect(fallbackOccurrences("The notion that apps matter", notion)).toEqual([]);
    expect(fallbackOccurrences("I'd pick Notion for this", notion)).toEqual([{ start: 9, end: 15 }]);
    expect(fallbackOccurrences("NOTION is great", notion)).toHaveLength(1);
  });
  it("short brand names: ≤2 chars never fall back; 3 chars need capitalization", () => {
    expect(fallbackOccurrences("Use X for posting", { brand: "X" })).toEqual([]);
    expect(fallbackOccurrences("Try Go", { brand: "Go" })).toEqual([]);
    expect(fallbackOccurrences("Box is solid", { brand: "Box" })).toHaveLength(1);
    expect(fallbackOccurrences("put it in a box", { brand: "Box" })).toEqual([]);
    expect(fallbackOccurrences("Dropbox is solid", { brand: "Box" })).toEqual([]);
  });
  it("target 'Notion AI' is not matched by plain 'Notion'", () => {
    expect(fallbackOccurrences("Notion is great", { brand: "Notion AI" })).toEqual([]);
    expect(fallbackOccurrences("Notion AI is great", { brand: "Notion AI" })).toHaveLength(1);
  });
  it("lowercase-typed brands match any case", () => {
    expect(fallbackOccurrences("Monday.com and monday.com", { brand: "monday.com" })).toHaveLength(2);
  });
  it("highlightSpans uses raw offsets", () => {
    const text = "Café tip: Notion’s AI and notion as a concept";
    const spans = highlightSpans(text, notion);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("Notion");
  });
});

describe("leaksBrand (question validator)", () => {
  const gw = { brand: "Google Workspace", aliases: ["Google Docs"] };
  it("catches the brand in any spelling", () => {
    expect(leaksBrand("Is Notion good for teams?", notion)).toBe("Notion");
    expect(leaksBrand("is notion good?", notion)).toBe("Notion");
    expect(leaksBrand("Apps like NotionHQ?", notion)).toBe("Notion");
    expect(leaksBrand("Best alternatives to GoogleDocs", gw)).toBe("Google Docs");
    expect(leaksBrand("Best alternatives to google-docs", gw)).toBe("Google Docs");
  });
  it("passes vendor-neutral questions", () => {
    expect(leaksBrand("What are the best note-taking apps for small teams?", notion)).toBeNull();
    expect(leaksBrand("What's a good budget note app?", gw)).toBeNull();
  });
  it("short names still use word boundaries (no 'inbox' false positive)", () => {
    expect(leaksBrand("Best inbox tools", { brand: "Box" })).toBeNull();
    expect(leaksBrand("Is Box worth it?", { brand: "Box" })).toBe("Box");
  });
});

describe("rankAnswer", () => {
  it("orders brands by first appearance in the text, not extractor order", () => {
    const s = rankAnswer(row("Top picks: Obsidian, then Notion, then Evernote.", ["Notion", "Obsidian", "Evernote"]), notion);
    expect(s.ranked.map((r) => r.name)).toEqual(["Obsidian", "Notion", "Evernote"]);
    expect(s.rank).toBe(2);
    expect(s.matchSource).toBe("extraction");
  });
  it("collapses 'Notion' and 'Notion AI' into one target mention", () => {
    const s = rankAnswer(row("Notion AI is neat. Obsidian too. Notion itself is flexible.", ["Notion AI", "Obsidian", "Notion"]), notion);
    expect(s.ranked.filter((r) => r.isTarget)).toHaveLength(1);
    expect(s.rank).toBe(1);
    expect(s.ranked).toHaveLength(2);
  });
  it("uses the raw-text fallback when extraction misses the brand, at its true position", () => {
    const s = rankAnswer(row("Obsidian is great. Notion is also good. Evernote is fine.", ["Obsidian", "Evernote"]), notion);
    expect(s.mentioned).toBe(true);
    expect(s.matchSource).toBe("fallback");
    expect(s.rank).toBe(2);
  });
  it("does not fallback-match the common word", () => {
    const s = rankAnswer(row("The notion of a second brain: Obsidian.", ["Obsidian"]), notion);
    expect(s.mentioned).toBe(false);
  });
  it("uses a capitalized occurrence to position a common-word brand", () => {
    const s = rankAnswer(row("In a bear market, pick Obsidian first, Bear second.", ["Obsidian", "Bear"]), notion);
    expect(s.ranked.map((r) => r.name)).toEqual(["Obsidian", "Bear"]);
  });
  it("keeps extractor order for names it can't locate in the text", () => {
    const s = rankAnswer(row("Obsidian, OneNote.", ["Obsidian", "Microsoft OneNote Suite", "Notion"]), notion);
    // Microsoft OneNote Suite isn't verbatim in the text → slots right after Obsidian.
    expect(s.ranked.map((r) => r.name)).toEqual(["Obsidian", "Microsoft OneNote Suite", "Notion"]);
  });
  it("maps extracted names onto user-listed competitors", () => {
    const s = rankAnswer(row("Microsoft OneNote and Obsidian", ["Microsoft OneNote", "Obsidian"]), notion, ["OneNote"]);
    expect(s.ranked[0]).toMatchObject({ name: "OneNote", key: "onenote" });
  });
  it("excludes brands that are the premise of the question", () => {
    const s = rankAnswer(
      row("Instead of Evernote, try Obsidian or Notion.", ["Evernote", "Obsidian", "Notion"], { question: "What are good alternatives to Evernote?" }),
      notion,
    );
    expect(s.ranked.map((r) => r.name)).toEqual(["Obsidian", "Notion"]);
    expect(s.rank).toBe(2);
  });
  it("does not treat lowercase words in the question as a premise brand", () => {
    const s = rankAnswer(row("Microsoft Teams, then Slack.", ["Teams", "Slack"], { question: "Best chat app for small teams?" }), notion);
    expect(s.ranked.map((r) => r.name)).toEqual(["Teams", "Slack"]);
  });
  it("rolls sub-products up into a parent brand named in the same answer", () => {
    const s = rankAnswer(row("Obsidian is best; add Obsidian Sync. Then Notion.", ["Obsidian", "Obsidian Sync", "Notion"]), notion);
    expect(s.ranked.map((r) => r.name)).toEqual(["Obsidian", "Notion"]);
  });
  it("failed rows are not ok", () => {
    expect(rankAnswer(row("", [], { status: "failed" }), notion).ok).toBe(false);
    expect(rankAnswer(row("text", [], { brands: null }), notion).ok).toBe(false);
  });
});

describe("statistics", () => {
  it("wilson interval matches known values", () => {
    const [lo, hi] = wilson(5, 10)!;
    expect(lo).toBeCloseTo(0.2366, 3);
    expect(hi).toBeCloseTo(0.7634, 3);
    const [lo0, hi0] = wilson(0, 10)!;
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.2775, 3);
    expect(wilson(10, 10)![1]).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });
  it("position weights", () => {
    expect(positionWeight(1)).toBe(1);
    expect(positionWeight(3)).toBe(0.5);
    expect(positionWeight(2)).toBeCloseTo(0.6309, 4);
  });
  it("two-proportion p-value", () => {
    expect(twoProportionP(5, 10, 5, 10)).toBeCloseTo(1, 6);
    expect(twoProportionP(90, 100, 10, 100)!).toBeLessThan(0.001);
    expect(twoProportionP(1, 0, 1, 1)).toBeNull();
  });
});

describe("sliceMetrics", () => {
  it("computes rate, avg position and position-weighted SoV; excludes failures", () => {
    const scored = [
      rankAnswer(row("Notion, Obsidian", ["Notion", "Obsidian"]), notion), // target rank 1
      rankAnswer(row("Obsidian, Evernote, Notion", ["Obsidian", "Evernote", "Notion"]), notion), // rank 3
      rankAnswer(row("Obsidian", ["Obsidian"]), notion), // not mentioned
      rankAnswer(row("", [], { status: "failed" }), notion),
    ];
    const m = sliceMetrics(scored);
    expect(m.n).toBe(3);
    expect(m.failed).toBe(1);
    expect(m.mentions).toBe(2);
    expect(m.rate).toBeCloseTo(2 / 3);
    expect(m.avgPosition).toBe(2);
    // target weight: 1 + 0.5 ; total: (1 + .6309) + (1 + .6309 + .5) + 1
    const w2 = 1 / Math.log2(3);
    expect(m.sov).toBeCloseTo(1.5 / (1 + w2 + 1 + w2 + 0.5 + 1), 6);
  });
  it("empty slice has null rate/CI", () => {
    const m = sliceMetrics([]);
    expect(m.rate).toBeNull();
    expect(m.ci).toBeNull();
    expect(m.sov).toBeNull();
  });
});

describe("computeReport", () => {
  const rows: AnswerInput[] = [
    row("Notion and Obsidian", ["Notion", "Obsidian"], { model: "a", track: "parametric" }),
    row("Obsidian only", ["Obsidian"], { model: "a", track: "parametric", sample: 2 }),
    row("Notion first", ["Notion"], { model: "a", track: "web" }),
    row("Notion again", ["Notion"], { model: "a", track: "web", sample: 2 }),
    row("", [], { model: "a", track: "web", sample: 3, status: "failed" }),
    // web-only model (like Perplexity) must not enter the paired track comparison
    row("Obsidian", ["Obsidian"], { model: "pplx", track: "web" }),
  ];
  const rep = computeReport(rows, notion, ["Evernote"]);

  it("breaks down by model × track with failures excluded", () => {
    expect(rep.byModelTrack["a|web"]).toMatchObject({ n: 2, failed: 1, mentions: 2, rate: 1 });
    expect(rep.byModelTrack["a|parametric"]).toMatchObject({ n: 2, mentions: 1, rate: 0.5 });
    expect(rep.overall).toMatchObject({ n: 5, failed: 1, mentions: 3 });
  });
  it("track gap only uses models that ran both tracks", () => {
    expect(rep.trackGap.pairedModels).toEqual(["a"]);
    expect(rep.trackGap.web.n).toBe(2);
    expect(rep.trackGap.delta).toBeCloseTo(0.5);
    // but the raw web slice includes pplx
    expect(rep.byTrack.web.n).toBe(3);
  });
  it("leaderboard ranks every brand by mention rate and lists zero-mention competitors", () => {
    expect(rep.leaderboard.map((e) => [e.name, e.mentions])).toEqual([
      ["Notion", 3],
      ["Obsidian", 3],
      ["Evernote", 0],
    ]);
    expect(rep.leaderboard[0].isTarget).toBe(true);
    expect(rep.leaderboard[2].isCompetitor).toBe(true);
  });
  it("folds name variants across answers and reports ties in the verdict", () => {
    const r = computeReport(
      [
        row("Microsoft OneNote, Notion", ["Microsoft OneNote", "Notion"]),
        row("OneNote first", ["OneNote"], { sample: 2 }),
      ],
      notion,
    );
    expect(r.leaderboard.map((e) => [e.name, e.mentions])).toEqual([
      ["OneNote", 2],
      ["Notion", 1],
    ]);
    expect(verdict(r, "Notion")).toContain("#2 of 2");
    // never fold a product into a bare company name across answers
    const r2 = computeReport([row("Apple Notes", ["Apple Notes"]), row("Apple", ["Apple"], { sample: 2 })], notion);
    expect(r2.leaderboard.map((e) => e.name)).toContain("Apple Notes");
    expect(verdict(rep, "Notion")).toContain("tied for #1");
    expect(trackInsight(rep, "Notion")).toContain("rises from 50% to 100%");
  });
});
