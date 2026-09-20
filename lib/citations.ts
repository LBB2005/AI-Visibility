/**
 * Citation analysis: which sites the models draw on when they answer, and whether
 * the target brand is merely *named* in the text or actually *cited* as a source.
 * Pure and unit-tested; no dependency on the scoring module (kept acyclic).
 */

import { fold } from "./match";

export type SourceCategory = "owned" | "competitor" | "community" | "reviews" | "editorial" | "reference" | "other";

export const CATEGORY_LABELS: Record<SourceCategory, string> = {
  owned: "Your site",
  competitor: "Competitor sites",
  community: "Community & social",
  reviews: "Review directories",
  editorial: "Press & editorial",
  reference: "Reference",
  other: "Other",
};

// Enough of the public suffix list to get registrable domains right for the sites
// LLM citations actually hit, without pulling in a full PSL dependency.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "or.jp", "ne.jp", "co.kr", "co.in", "net.in", "org.in", "com.br",
  "com.mx", "com.ar", "com.sg", "com.hk", "com.tw", "com.cn", "com.tr", "co.za", "com.es", "com.pl",
  "co.il", "com.ua", "com.ph", "com.my", "com.vn", "co.id", "com.pk", "com.sa", "com.eg", "com.ng",
]);

const COMMUNITY = new Set([
  "reddit.com", "quora.com", "stackexchange.com", "stackoverflow.com", "superuser.com", "serverfault.com",
  "ycombinator.com", "youtube.com", "x.com", "twitter.com", "linkedin.com", "facebook.com", "instagram.com",
  "tiktok.com", "threads.net", "medium.com", "substack.com", "discord.com", "slack.com", "discourse.org",
  "github.com", "gitlab.com", "hashnode.dev", "dev.to", "mastodon.social", "bsky.app", "tumblr.com", "pinterest.com",
]);

const REVIEWS = new Set([
  "g2.com", "capterra.com", "getapp.com", "softwareadvice.com", "trustradius.com", "trustpilot.com",
  "producthunt.com", "alternativeto.net", "sourceforge.net", "slashdot.org", "gartner.com", "saasworthy.com",
  "goodfirms.co", "crozdesk.com", "financesonline.com", "appsumo.com", "apps.apple.com", "play.google.com",
]);

const REFERENCE = new Set([
  "wikipedia.org", "wikimedia.org", "wiktionary.org", "britannica.com", "arxiv.org", "acm.org", "ieee.org",
  "nist.gov", "who.int", "europa.eu", "doi.org", "crunchbase.com", "statista.com", "sec.gov",
]);

const EDITORIAL = new Set([
  "techcrunch.com", "theverge.com", "wired.com", "pcmag.com", "zdnet.com", "cnet.com", "tomsguide.com",
  "tomshardware.com", "techradar.com", "engadget.com", "arstechnica.com", "forbes.com", "businessinsider.com",
  "nytimes.com", "wsj.com", "ft.com", "theguardian.com", "bbc.co.uk", "bbc.com", "cnbc.com", "bloomberg.com",
  "makeuseof.com", "lifehacker.com", "howtogeek.com", "digitaltrends.com", "mashable.com", "venturebeat.com",
  "fastcompany.com", "inc.com", "entrepreneur.com", "hbr.org", "theinformation.com", "axios.com", "reuters.com",
  "zapier.com", "pcworld.com", "computerworld.com", "infoworld.com", "gizmodo.com", "androidpolice.com", "9to5mac.com",
  // Money/consumer media, which review the products they write about and are easily
  // mistaken for vendors because their own names get extracted as brands.
  "nerdwallet.com", "investopedia.com", "fool.com", "bankrate.com", "money.com", "marketwatch.com", "kiplinger.com",
  "morningstar.com", "thestreet.com", "creditkarma.com", "wirecutter.com", "consumerreports.org", "which.co.uk",
]);

/**
 * Some providers cite through a redirector instead of the real page — Gemini's
 * grounding API returns `vertexaisearch.cloud.google.com/grounding-api-redirect/…`
 * and puts the actual domain in the citation title. Attributing those to google.com
 * would silently misfile real citations, so we read the title and otherwise give up.
 */
const REDIRECTORS = [/vertexaisearch\.cloud\.google\.com/i, /grounding-api-redirect/i, /\/url\?q=/i];
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function resolveCitation(c: { url: string; title?: string }): string | null {
  const url = c?.url ?? "";
  if (REDIRECTORS.some((re) => re.test(url))) {
    const title = (c.title ?? "").trim();
    return BARE_HOST.test(title) ? registrableDomain(title) : null;
  }
  return registrableDomain(url);
}

/** Registrable domain for a URL ("https://www.bbc.co.uk/news" → "bbc.co.uk"), or null. */
export function registrableDomain(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  let host: string;
  try {
    host = new URL(url.includes("://") ? url : `https://${url}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!host || !host.includes(".")) return null;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

const squash = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, "");

/** Does this domain look like it belongs to `name`? ("Evernote" → evernote.com) */
export function domainMatchesName(domain: string, name: string): boolean {
  const label = domain.split(".")[0];
  if (!label || !name.trim()) return false;
  const full = squash(name);
  if (full.length >= 3 && label === full) return true;
  const firstWord = squash(fold(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean)[0] ?? "");
  return firstWord.length >= 4 && label === firstWord;
}

export interface CitationContext {
  /** The target's own website, if the user supplied one. */
  brandDomain?: string | null;
  /** Brand and alias names for the target. */
  targetNames: string[];
  /** Competitors the user named explicitly — trusted over every other rule. */
  explicitCompetitors?: string[];
  /** Brands extracted anywhere in the run; used only as a last-resort guess. */
  competitorNames?: string[];
}

/**
 * Precedence matters. Media that review products (NerdWallet, Forbes, Investopedia) get
 * their own names extracted as brands, so inferring "competitor" from extracted names
 * ahead of the curated lists would file most of the press as rival vendors. Order:
 * what the user told us, then what we know about the site, then inference.
 */
export function classifyDomain(domain: string, ctx: CitationContext): SourceCategory {
  const owned = ctx.brandDomain ? registrableDomain(ctx.brandDomain) : null;
  if (owned && domain === owned) return "owned";
  if (ctx.targetNames.some((n) => domainMatchesName(domain, n))) return "owned";
  if ((ctx.explicitCompetitors ?? []).some((n) => domainMatchesName(domain, n))) return "competitor";
  if (COMMUNITY.has(domain)) return "community";
  if (REVIEWS.has(domain)) return "reviews";
  if (REFERENCE.has(domain) || /\.(edu|gov|ac\.uk)$/.test(domain)) return "reference";
  if (EDITORIAL.has(domain)) return "editorial";
  if ((ctx.competitorNames ?? []).some((n) => domainMatchesName(domain, n))) return "competitor";
  return "other";
}

/** One answer, reduced to what citation analysis needs. */
export interface CitationAnswer {
  ok: boolean;
  track: string;
  mentioned: boolean;
  citations: { url: string; title?: string }[] | null;
}

export interface DomainStat {
  domain: string;
  category: SourceCategory;
  /** Answers citing this domain at least once (an answer counts once, however often it cites). */
  answers: number;
  /** Share of citing answers that cite this domain. */
  share: number;
  /** Of those answers, how many name the target. */
  withTarget: number;
  targetRate: number | null;
  /** targetRate here minus targetRate in answers that don't cite it; null when too few answers. */
  lift: number | null;
}

export interface CitationReport {
  /** Counted (ok) answers on the web track. */
  webAnswers: number;
  /** …of which this many returned at least one citation. */
  withCitations: number;
  /** Distinct (answer, domain) pairs — the denominator for citation share. */
  uniquePairs: number;
  /** Citations we couldn't attribute to a real site (redirect wrappers without a usable title). */
  unresolved: number;
  domains: DomainStat[];
  byCategory: { category: SourceCategory; answers: number; share: number }[];
  /**
   * Named vs. cited: is the brand in the prose, in the sources, both, or neither?
   * Computed over web answers that returned citations.
   */
  cross: { namedAndCited: number; namedNotCited: number; citedNotNamed: number; neither: number };
  /** Share of citing answers whose sources include a domain owned by the target. */
  citationRate: number | null;
  /** Target mention rate over the same answers, for a like-for-like comparison. */
  mentionRate: number | null;
}

/** Below this many citing answers, a lift number is noise — we report the rate without it. */
export const MIN_LIFT_ANSWERS = 5;

export function citationReport(answers: CitationAnswer[], ctx: CitationContext): CitationReport | null {
  const web = answers.filter((a) => a.ok && a.track === "web");
  if (!web.length) return null;

  let unresolved = 0;
  const perAnswer = web.map((a) => {
    const domains = new Set<string>();
    for (const c of a.citations ?? []) {
      const d = resolveCitation(c ?? { url: "" });
      if (d) domains.add(d);
      else unresolved++;
    }
    return { mentioned: a.mentioned, domains };
  });
  const citing = perAnswer.filter((a) => a.domains.size > 0);
  if (!citing.length) return null;

  const agg = new Map<string, { answers: number; withTarget: number }>();
  for (const a of citing) {
    for (const d of a.domains) {
      const e = agg.get(d) ?? { answers: 0, withTarget: 0 };
      e.answers++;
      if (a.mentioned) e.withTarget++;
      agg.set(d, e);
    }
  }

  const mentionsInCiting = citing.filter((a) => a.mentioned).length;
  const domains: DomainStat[] = [...agg.entries()]
    .map(([domain, e]) => {
      const category = classifyDomain(domain, ctx);
      const othersN = citing.length - e.answers;
      const othersHits = mentionsInCiting - e.withTarget;
      const lift =
        e.answers >= MIN_LIFT_ANSWERS && othersN > 0 ? e.withTarget / e.answers - othersHits / othersN : null;
      return {
        domain,
        category,
        answers: e.answers,
        share: e.answers / citing.length,
        withTarget: e.withTarget,
        targetRate: e.answers ? e.withTarget / e.answers : null,
        lift,
      };
    })
    .sort((a, b) => b.answers - a.answers || a.domain.localeCompare(b.domain));

  const catCounts = new Map<SourceCategory, number>();
  for (const a of citing) {
    const seen = new Set<SourceCategory>();
    for (const d of a.domains) seen.add(classifyDomain(d, ctx));
    for (const c of seen) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
  }
  const byCategory = [...catCounts.entries()]
    .map(([category, answers]) => ({ category, answers, share: answers / citing.length }))
    .sort((a, b) => b.answers - a.answers);

  const ownedOf = (doms: Set<string>) => [...doms].some((d) => classifyDomain(d, ctx) === "owned");
  const cross = { namedAndCited: 0, namedNotCited: 0, citedNotNamed: 0, neither: 0 };
  for (const a of citing) {
    const cited = ownedOf(a.domains);
    if (a.mentioned && cited) cross.namedAndCited++;
    else if (a.mentioned) cross.namedNotCited++;
    else if (cited) cross.citedNotNamed++;
    else cross.neither++;
  }

  return {
    webAnswers: web.length,
    withCitations: citing.length,
    uniquePairs: citing.reduce((s, a) => s + a.domains.size, 0),
    unresolved,
    domains,
    byCategory,
    cross,
    citationRate: (cross.namedAndCited + cross.citedNotNamed) / citing.length,
    mentionRate: mentionsInCiting / citing.length,
  };
}
