# AI Visibility Checker

**Does AI recommend your brand when people ask about your category?**

A local web app that measures how often large language models name a given brand when a buyer asks a *vendor-neutral* question in its category, such as "what's the best note-taking app for a small team?". It runs a battery of buyer-intent questions across Claude, OpenAI, Gemini, and Perplexity, both from model memory and with live web search. It then reports the mention rate with confidence intervals (including a question-clustered bootstrap), average position, position-weighted share of voice, a competitor leaderboard, and an analysis of which sources the models actually cite — including whether your brand is merely *named* or actually *cited*.

Built for answer engine optimization (AEO) work: the question it answers is "when an AI assistant is the storefront, are we on the shelf?"

---

## Setup

Requires Node 22+ and an [OpenRouter](https://openrouter.ai/keys) API key.

```bash
npm install
cp .env.example .env.local   # then paste your OPENROUTER_API_KEY
npm run dev                  # http://localhost:3000
npm test                     # vitest: scoring + matcher suite
```

Runs are stored in `data/avc.db` (SQLite, gitignored). `.env.local` is gitignored and never committed.

| Env var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | (required) | All model calls go through OpenRouter |
| `AVC_CACHE` | on in dev, off in prod | `1`/`0` forces the request cache on or off |
| `AVC_DB_PATH` | `data/avc.db` | SQLite location |
| `AVC_GOLD_DIR` | `gold/` | Where the extractor gold set and its report live |

## Using it

1. Fill in the sentence on the home page: *Does AI recommend **[brand]** when people ask about **[category]**?* Add aliases (other names that count as the brand, e.g. `Google Docs` for Google Workspace), competitors you want tracked even at zero mentions, and optionally your website, which makes the citation analysis exact.
2. **Draft questions** generates a battery of buyer-intent questions. You can edit, add, or remove any of them. A question that names the brand is flagged and excluded.
3. Choose models (the defaults are picked live from OpenRouter's `/models` catalog) and the sample count. The call count and estimated cost update as you change them.
4. **Run the check.** Progress streams in, and metrics update as answers land. When the run finishes you get the verdict, the model × track heatmap, the memory-vs-web gap, the competitor leaderboard, and a drilldown into every answer with the brand highlighted.
5. Every run is saved to **History**. **Export raw rows (CSV)** gives one line per question × model × track × sample, including the domains each answer cited. `/methods` explains every metric; `/label` is the blind labeling tool for validating the extractor.

---

## Methodology

### Why questions never name the brand

The point is to measure **unprompted recommendation**: does the model bring up the brand on its own when a buyer describes a need? If the question names the brand ("Is Notion good for teams?"), the answer will mention it every time, and the mention rate measures nothing. So:

- **The generator never sees the brand.** The first pass sends only the category and the intent slots, so the battery can't be tilted toward or away from the target, even unintentionally.
- **Every question is validated in code** (`leaksBrand` in `lib/match.ts`). A question is rejected if it contains the brand or any alias, case-insensitively, with any spacing or hyphenation ("Google Docs", "google-docs", "GoogleDocs"). For names of 4+ characters, any token that contains the name also counts ("NotionHQ", "#notion"). This check is deliberately over-eager.
- A rejected slot is regenerated once, and that retry does include an explicit "never mention X" list. If it fails again, it's dropped.
- The same check runs **server-side on submit**, so a hand-edited question can't slip the brand back in.

### The question battery

Up to 10 questions, filled in priority order so that small batteries still cover the core intents: best overall, small team, alternatives to the market leader, enterprise, budget/value, shortlist/comparison, beginner, specific use case, a second best-overall phrasing ("what do most people use?"), and a second use case.

The *alternatives* question names the category leader ("I'm leaving Evernote…"). A brand named in the question is the **premise, not a recommendation**, so it's excluded from that answer's ranking (see Matching).

### Tracks

Each model answers each question twice:

- **Parametric**: the plain model, answering from training data.
- **Web**: the same model with OpenRouter's web plugin (`plugins: [{ id: "web", max_results: 5 }]`, equivalent to the `:online` suffix). OpenRouter uses the provider's native search where one exists and falls back to Exa otherwise.

**Perplexity Sonar always searches the web**, so it has no true parametric track. It runs on the web track only, and the heatmap marks its parametric cell as not applicable instead of presenting a web-grounded answer as memory.

### Repeats

LLM output is stochastic, so each question × model × track is sampled **N times** (default 3). The dev cache key includes the sample index, so repeats are genuinely independent calls.

### Answer generation

The question is sent as a **single plain user message**, with no system prompt, no JSON or format instructions, and provider-default temperature and length. The answer has to be what a real user would see, not something shaped by the measurement.

### Extraction

A **separate, cheap model call** (the newest structured-output model under $0.50/M input, picked from the catalog) reads each answer and returns strict JSON:

```json
{ "brands": [{ "name": "Obsidian", "first_position": 1 }, { "name": "Notion", "first_position": 2 }] }
```

It lists every company or product named, in order of first appearance, and excludes generic categories and cited sources. The output is validated with zod and retried once on bad JSON. If both attempts fail, the row is recorded as failed.

### Matching and ranking

Matching lives in `lib/match.ts` and ranking in `lib/scoring.ts` — pure modules with unit tests.

- **Primary match:** an extracted name refers to the target if it contains the brand or an alias as a whole word or phrase, case-insensitively. "Notion AI" counts as Notion. Plain "Notion" does **not** count for a target of "Notion AI". "Dropbox" never matches "Box".
- **Fallback match:** if extraction missed the brand, the raw answer text is searched on word boundaries, with two guards against common-word brands:
  - An all-lowercase occurrence of a capitalized brand is ignored, because "the notion that…" and "bear in mind" are not brands.
  - Names of 2 or fewer letters or digits ("X", "Go") never use the fallback. They're too ambiguous, so they rely on extraction only.

  Fallback-only matches are counted and shown ("text match").
- **Position is taken from the text, not the extractor.** Each brand is located by its first occurrence in the actual answer, preferring a capitalized occurrence. Brands the extractor named but that can't be found verbatim keep the extractor's relative order.
- **Deduplication and roll-ups:**
  - The target appears at most once per answer ("Notion" and "Notion AI" collapse into one).
  - A sub-product folds into its parent when both are named ("Obsidian Sync" becomes "Obsidian").
  - Name variants across the run fold into the shorter, more common form ("Microsoft OneNote" becomes "OneNote").
  - Names that contain a user-listed competitor map to that competitor.
- **Premise exclusion:** brands named in the question itself are dropped from that answer's ranking.

### Metrics

Failed calls are excluded from every denominator, and the number of exclusions is always shown.

| Metric | Definition | Why |
|---|---|---|
| **Mention rate** (headline) | Share of answers that name the brand, *k / n* | The simplest question: are you on the shelf? |
| **95% confidence interval** | Wilson score interval on *k / n* | Sample sizes are small (tens to hundreds). Wilson behaves well near 0% and 100%, where the normal approximation breaks down. |
| **Average position** | Mean 1-based rank of the brand among brands in the answer, counting only answers that name it | Being named first is different from being named seventh |
| **Share of voice** | Σ target weight ÷ Σ weight of all brands, with weight *1 / log₂(rank + 1)* | Blends presence and prominence. Rank 1 weighs 1.0, rank 2 weighs 0.63, rank 3 weighs 0.5 (DCG-style discount). It's computed as a ratio of sums over the slice, so long answers don't get extra influence. |
| **Clustered interval** | Percentile bootstrap resampling whole **questions** (2,000 times, seeded) | Answers to one question aren't independent draws, so the naive interval is too narrow. [Miller 2024](https://arxiv.org/abs/2411.00640) finds clustered SEs several times the naive ones. At 0% or 100% every resample is identical, and the app says so rather than printing a fake ±0. |
| **Leaderboard** | Every brand's mention rate (with CI), average position, and SoV over the same answers | Puts the target's number in context. User-listed competitors appear even at zero. |

Every metric is broken down **by model**, **by track**, and **by model × track** (the heatmap), and by question in the drilldown.

**The memory vs. web gap** is computed only over models that ran *both* tracks, so web-only Perplexity can't skew it. It's reported per model and pooled, with a question-clustered bootstrap p-value; the naive z-test that ignores clustering is shown beside it for comparison. If the gap isn't significant at this sample size, the app says so rather than implying a finding. A large positive gap means current web content surfaces the brand more than training data does, which is a signal that recent content and PR are working. A negative gap means the brand's visibility is mostly historical.

### Named vs. cited

On the web track, models return the sources they read. Each is resolved to a registrable domain and bucketed into your site, a competitor's, community and social, review directories, press, reference, or other. Precedence matters: your explicit competitor list wins, then the curated site lists, then inference from brand names — otherwise media that get extracted as brands (NerdWallet, Forbes, Investopedia) would be filed as rival vendors. Gemini cites through a redirect wrapper, so those resolve via the citation title and are counted as unresolved when that fails, never credited to Google.

A **mention** is the brand in the answer text. A **citation** is the brand's own domain in that answer's sources. The 2×2 between them is the useful part:

- *named but not cited* — models describe you from other people's pages, so third-party placement is the lever;
- *cited but not named* — a model read your site and recommended someone else anyway.

**Lift** for a source compares the brand's mention rate in answers citing it against answers that don't, suppressed below 5 citing answers. It's a correlation: a site that already recommends you will correlate with your being named without having caused it.

### Validating the extractor

The extraction step is a model, so it's measured rather than trusted. `/label` serves one answer at a time as plain, unhighlighted text, and the model's extraction stays server-side until a label is submitted — both anchoring guards are deliberate. `npm run gold:validate` then writes `gold/validation.md` with Cohen's kappa on the binary "does this answer name the brand" decision for two deciders (the extraction model alone, and the full pipeline including the raw-text fallback — the difference is what the fallback buys), alongside raw agreement, PABAK, prevalence, and micro-averaged precision/recall/F1 on the brand sets. Because the gold set skews toward answers that do name a major brand, kappa is always read next to raw agreement. `lib/gold.test.ts` replays the labeled set on every `npm test` and skips cleanly when no gold set is present.

---

## Architecture

```
app/
  page.tsx                   hero sentence → question editor → models → estimate → run
  runs/[id]/page.tsx         live progress, then results
  history/page.tsx           saved runs
  api/models                 live catalog from OpenRouter /models + default picks
  api/questions              battery generation + leak validation
  api/runs                   POST create+start run · GET list
  api/runs/[id]              GET status/report (?rows=1 for answers) · POST resume|retry-failed · DELETE
  api/runs/[id]/csv          raw-row export
  api/gold                   serves unlabeled answers (extraction redacted) and saves labels
  methods/                   how every metric is computed, with citations
  label/                     blind labeling UI for the extractor gold set
lib/
  match.ts                   pure: folding, word-boundary matching, raw-text fallback, leak validator
  stats.ts                   pure: Wilson, cluster bootstrap, bootstrap difference test, Cohen's kappa
  citations.ts               pure: domain resolution, source buckets, named-vs-cited, source lift
  scoring.ts                 pure: ranking, breakdowns, leaderboard, track gap, verdicts
  gold.ts / goldStore.ts     extractor gold set: schema, agreement math, file access
  *.test.ts                  vitest suites, one per module
  openrouter.ts              fetch client: 4 in-flight limit, exponential backoff, dev cache
  questions.ts               battery generation
  extract.ts                 extraction call + zod schema
  pipeline.ts                background run worker; never throws per call
  models.ts / estimate.ts    catalog, default picks, cost estimate
  db.ts / report.ts          SQLite access, API payloads
```

**Data model (SQLite):**
- `runs`: brand, aliases, category, competitors, questions, models, samples, extractor, status, estimated cost.
- `answers`: one row per question × model × track × sample, with status (`pending | ok | failed`), failed stage, error, answer text, extracted brands, citations, cost, latency, and a cached flag.
- `cache`: request hash → response, used in development only.

**Reliability:**
- **Concurrency:** at most 4 requests in flight process-wide.
- **Retries:** exponential backoff with jitter on 429, 5xx, timeouts, and empty completions, honoring `Retry-After`.
- **No crashes on one bad call:** a failed call is recorded on its row and excluded from metrics.
- **Resume and retry:** a run cut off by a server restart shows as *interrupted* and can be resumed. Failed rows can be retried from the results page.

**CSV columns:** `run_id, question_idx, question, intent, model, track, sample, status, failed_stage, error, target_mentioned, target_rank, match_source, brands_ranked, answer, citations, cited_domains, own_domain_cited, cost_usd, cached`.

---

## Known limitations

- **API, not product.** OpenRouter calls the model APIs. ChatGPT, Gemini, and Claude.ai add their own system prompts, memory, personalization, and search stacks, so absolute rates will differ from what a consumer sees. The relative comparisons (across brands, models, and tracks) are the robust part.
- **Web track depends on the search backend.** Native search versus OpenRouter's Exa fallback differs by provider, so web-track results across providers aren't perfectly like-for-like.
- **Samples aren't fully independent.** Answers to the same question are correlated, so the Wilson intervals (which assume independent draws) are somewhat optimistic. More distinct questions tighten estimates more than more samples of the same question.
- **Extraction is itself a model.** It can miss or over-include brands, for example a publication named in the prose ("according to PCMag"). The raw-text fallback catches misses of the target. It doesn't fix competitor extraction errors.
- **Every named product counts.** Incidental mentions (e.g. "sync via iCloud") dilute share of voice. The leaderboard shows this directly rather than hiding it.
- **Common-word brands.** A capitalized sentence-initial word ("Bear in mind…") can still pass the fallback when extraction misses the brand. Brands of 2 or fewer characters rely on extraction alone.
- **Name roll-ups are heuristic.** Folding "Microsoft OneNote" into "OneNote" is usually right. It can over-merge when a bare company name ("Google") is also extracted.
- **Snapshot in time.** Model versions and web indexes change. Default models are re-picked from the live catalog, so reruns weeks apart may use different models; the model id is stored on each run.
- **Source buckets are heuristic.** Community, review, press and reference sites come from curated lists, so the long tail lands in "other". Only *your site* and *competitor* are derived from the run's own brands, and only those feed a headline number.
- **Source lift is observational.** It cannot separate "this source made models recommend you" from "this source already recommends you".
- **Cost is estimated.** The pre-run figure uses average token counts. Actual per-row cost comes from OpenRouter usage accounting and is shown during the run.
