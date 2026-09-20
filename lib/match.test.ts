import { describe, expect, it } from "vitest";
import { containsTerm, fallbackOccurrences, fold, highlightSpans, leaksBrand, nameMatchesTarget } from "./match";

const notion = { brand: "Notion" };

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
