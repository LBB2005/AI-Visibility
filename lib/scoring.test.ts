import { describe, expect, it } from "vitest";
import { computeReport, rankAnswer, sliceMetrics, trackInsight, verdict, type AnswerInput } from "./scoring";

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

  it("skips resampling unless asked, and clusters by question when asked", () => {
    expect(rep.clustered).toBeNull();
    expect(rep.trackGap.bootstrap).toBeNull();

    // Same mention pattern repeated across 6 questions so there is something to resample.
    const many: AnswerInput[] = [];
    for (let q = 0; q < 6; q++) {
      many.push(row("Notion and Obsidian", ["Notion", "Obsidian"], { questionIdx: q, model: "a", track: "parametric" }));
      many.push(row("Obsidian only", ["Obsidian"], { questionIdx: q, model: "a", track: "web" }));
    }
    const boot = computeReport(many, notion, [], { bootstrap: true, iterations: 300 });
    expect(boot.clustered!.overall.rate).toMatchObject({ point: 0.5, clusters: 6 });
    expect(boot.clustered!.byTrack.parametric.rate!.point).toBe(1);
    expect(boot.trackGap.bootstrap!.delta).toBeCloseTo(-1);
    expect(boot.trackGap.bootstrap!.p).toBeLessThan(0.05);
  });

  it("keeps long-list answers out of the headline and reports them as a census", () => {
    const buyer = [
      row("Obsidian is best.", ["Obsidian"], { questionIdx: 0 }),
      row("Obsidian again.", ["Obsidian"], { questionIdx: 1, sample: 2 }),
    ];
    // A 12-name list that includes the target at rank 11 — named, but deep.
    const names = ["Obsidian", "OneNote", "Evernote", "Bear", "Joplin", "Craft", "Logseq", "Roam", "Agenda", "Drafts", "Notion", "Supernote"];
    const list = [
      row(names.join(", "), names, { questionIdx: 2, kind: "list" }),
      row(names.join(", "), names, { questionIdx: 3, kind: "list", sample: 1 }),
    ];
    const rep = computeReport([...buyer, ...list], notion, []);

    // Headline ignores the list answers entirely: the brand is named in neither buyer answer.
    expect(rep.overall).toMatchObject({ n: 2, mentions: 0, rate: 0 });

    const c = rep.census!;
    expect(c.answers).toBe(2);
    expect(c.listedRate).toBe(1);
    expect(c.avgPosition).toBe(11);
    expect(c.top10Rate).toBe(0); // named, but never in the first ten
    expect(c.avgListLength).toBe(12);
    expect(c.brands.length).toBeGreaterThan(10);
    expect(rep.overall.n + c.answers).toBe(4);
  });

  it("returns a score for every input row, in order, so callers can pair them back", () => {
    const mixed = [row("Notion.", ["Notion"], { questionIdx: 0 }), row("A, B.", ["A", "B"], { questionIdx: 1, kind: "list" })];
    const r = computeReport(mixed, notion, []);
    expect(r.scored).toHaveLength(mixed.length);
    expect(r.scored.map((s) => s.input.kind ?? "buyer")).toEqual(["buyer", "list"]);
  });

  it("flags brands that appear in only one long list as unverified", () => {
    const common = ["Obsidian", "OneNote"];
    const rep = computeReport(
      [
        row("Obsidian, OneNote, Zzyzx Notes", [...common, "Zzyzx Notes"], { questionIdx: 0, kind: "list" }),
        row("Obsidian, OneNote", common, { questionIdx: 1, kind: "list" }),
      ],
      notion,
      [],
    );
    expect(rep.census!.unverifiedNames).toEqual(["Zzyzx Notes"]);
    expect(rep.census!.unverified).toBe(1);
    // With no buyer questions at all, the headline falls back to every answer.
    expect(rep.overall.n).toBe(2);
  });

  it("attaches a citation report when web answers carry citations", () => {
    const withCites: AnswerInput[] = [
      row("Notion is great", ["Notion"], { track: "web", citations: [{ url: "https://reddit.com/r/x" }, { url: "https://notion.so/a" }] }),
      row("Obsidian only", ["Obsidian"], { track: "web", sample: 2, citations: [{ url: "https://reddit.com/r/y" }] }),
    ];
    const r = computeReport(withCites, notion, [], { brandDomain: "notion.so" });
    expect(r.citations!.withCitations).toBe(2);
    expect(r.citations!.domains[0].domain).toBe("reddit.com");
    expect(r.citations!.cross).toMatchObject({ namedAndCited: 1, neither: 1 });
    // parametric-only runs have no citation section at all
    expect(computeReport(rows, notion).citations).toBeNull();
  });
});
