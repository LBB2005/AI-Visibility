import { describe, expect, it } from "vitest";
import { citationReport, classifyDomain, domainMatchesName, registrableDomain, resolveCitation, type CitationAnswer } from "./citations";

describe("registrableDomain", () => {
  it("strips www, paths and subdomains", () => {
    expect(registrableDomain("https://www.reddit.com/r/notes/comments/123")).toBe("reddit.com");
    expect(registrableDomain("https://docs.google.com/document/d/1")).toBe("google.com");
    expect(registrableDomain("notion.so/help")).toBe("notion.so");
  });
  it("handles multi-part suffixes", () => {
    expect(registrableDomain("https://www.bbc.co.uk/news/tech")).toBe("bbc.co.uk");
    expect(registrableDomain("https://blog.example.com.au")).toBe("example.com.au");
  });
  it("returns null for junk", () => {
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain("not a url")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
  });
});

describe("resolveCitation (redirect wrappers)", () => {
  it("reads the real domain from the title of a Gemini grounding redirect", () => {
    const url = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
    expect(resolveCitation({ url, title: "fidelity.com" })).toBe("fidelity.com");
    // Without a usable title we refuse to guess rather than crediting google.com.
    expect(resolveCitation({ url, title: "Fidelity — retirement accounts" })).toBeNull();
    expect(resolveCitation({ url })).toBeNull();
  });
  it("passes ordinary citations straight through", () => {
    expect(resolveCitation({ url: "https://www.reddit.com/r/x", title: "Reddit" })).toBe("reddit.com");
  });
});

describe("classifyDomain", () => {
  const ctx = { brandDomain: "https://notion.so", targetNames: ["Notion"], competitorNames: ["Evernote", "Microsoft OneNote"] };
  it("recognises owned, competitor and category sources", () => {
    expect(classifyDomain("notion.so", ctx)).toBe("owned");
    expect(classifyDomain("notion.com", ctx)).toBe("owned"); // name match, different TLD
    expect(classifyDomain("evernote.com", ctx)).toBe("competitor");
    expect(classifyDomain("microsoft.com", ctx)).toBe("competitor"); // first word of "Microsoft OneNote"
    expect(classifyDomain("reddit.com", ctx)).toBe("community");
    expect(classifyDomain("g2.com", ctx)).toBe("reviews");
    expect(classifyDomain("en.wikipedia.org", { ...ctx })).toBe("other"); // caller passes registrable domains
    expect(classifyDomain("wikipedia.org", ctx)).toBe("reference");
    expect(classifyDomain("stanford.edu", ctx)).toBe("reference");
    expect(classifyDomain("techcrunch.com", ctx)).toBe("editorial");
    expect(classifyDomain("some-random-blog.io", ctx)).toBe("other");
  });
  it("keeps review media out of the competitor bucket when their name is extracted as a brand", () => {
    // "NerdWallet" and "Forbes" get extracted as brands in finance categories.
    const finance = { targetNames: ["Yahoo"], competitorNames: ["NerdWallet", "Forbes", "Fidelity"] };
    expect(classifyDomain("nerdwallet.com", finance)).toBe("editorial");
    expect(classifyDomain("forbes.com", finance)).toBe("editorial");
    expect(classifyDomain("fidelity.com", finance)).toBe("competitor"); // a real rival vendor
    // An explicitly named competitor outranks every other rule.
    expect(classifyDomain("forbes.com", { ...finance, explicitCompetitors: ["Forbes"] })).toBe("competitor");
  });
  it("does not match short or partial names", () => {
    expect(domainMatchesName("boxes.com", "Box")).toBe(false);
    expect(domainMatchesName("box.com", "Box")).toBe(true);
    expect(domainMatchesName("notionally.com", "Notion")).toBe(false);
  });
});

describe("citationReport", () => {
  const ctx = { brandDomain: "notion.so", targetNames: ["Notion"], competitorNames: ["Obsidian"] };
  const answer = (mentioned: boolean, urls: string[], track = "web"): CitationAnswer => ({
    ok: true,
    track,
    mentioned,
    citations: urls.map((url) => ({ url })),
  });

  it("counts each (answer, domain) pair once, however often the answer cites it", () => {
    const rep = citationReport(
      [answer(true, ["https://reddit.com/a", "https://reddit.com/b", "https://www.reddit.com/c"])],
      ctx,
    )!;
    expect(rep.domains).toHaveLength(1);
    expect(rep.domains[0]).toMatchObject({ domain: "reddit.com", answers: 1, share: 1 });
    expect(rep.uniquePairs).toBe(1);
  });

  it("separates being named from being cited", () => {
    const rep = citationReport(
      [
        answer(true, ["https://notion.so/product"]), // named and cited
        answer(true, ["https://reddit.com/x"]), // named, not cited
        answer(false, ["https://notion.so/blog"]), // cited, not named
        answer(false, ["https://g2.com/x"]), // neither
      ],
      ctx,
    )!;
    expect(rep.cross).toEqual({ namedAndCited: 1, namedNotCited: 1, citedNotNamed: 1, neither: 1 });
    expect(rep.citationRate).toBe(0.5);
    expect(rep.mentionRate).toBe(0.5);
  });

  it("only reports lift when enough answers cite the domain", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => answer(true, ["https://reddit.com/x"])),
      ...Array.from({ length: 5 }, () => answer(false, ["https://g2.com/y"])),
    ];
    const rep = citationReport(rows, ctx)!;
    const reddit = rep.domains.find((d) => d.domain === "reddit.com")!;
    const g2 = rep.domains.find((d) => d.domain === "g2.com")!;
    expect(reddit.lift).toBeCloseTo(1); // 100% here vs 0% elsewhere
    expect(g2.lift).toBeCloseTo(-1);

    const few = citationReport([answer(true, ["https://reddit.com/x"]), answer(false, ["https://g2.com/y"])], ctx)!;
    expect(few.domains.every((d) => d.lift === null)).toBe(true);
    expect(few.domains[0].targetRate).not.toBeNull();
  });

  it("counts citations it cannot attribute", () => {
    const rep = citationReport(
      [
        {
          ok: true,
          track: "web",
          mentioned: true,
          citations: [{ url: "https://reddit.com/a" }, { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x", title: "A page" }],
        },
      ],
      ctx,
    )!;
    expect(rep.unresolved).toBe(1);
    expect(rep.domains).toHaveLength(1);
  });

  it("ignores the parametric track and returns null when there is nothing to analyse", () => {
    expect(citationReport([answer(true, ["https://reddit.com/x"], "parametric")], ctx)).toBeNull();
    expect(citationReport([answer(true, [])], ctx)).toBeNull();
    expect(citationReport([], ctx)).toBeNull();
    const mixed = citationReport([answer(true, ["https://reddit.com/x"]), answer(true, [], "parametric")], ctx)!;
    expect(mixed.webAnswers).toBe(1);
    expect(mixed.withCitations).toBe(1);
  });

  it("groups categories per answer, counting each category once", () => {
    const rep = citationReport(
      [answer(true, ["https://reddit.com/a", "https://quora.com/b", "https://techcrunch.com/c"])],
      ctx,
    )!;
    const community = rep.byCategory.find((c) => c.category === "community")!;
    expect(community.answers).toBe(1);
    expect(rep.byCategory.find((c) => c.category === "editorial")!.answers).toBe(1);
  });
});
