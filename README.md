# AI Visibility Checker

**Does AI recommend your brand when people ask about your category?**

A local web app that measures how often large language models name a given brand when a buyer asks a *vendor-neutral* question in its category, such as "what's the best note-taking app for a small team?". It runs a battery of buyer-intent questions across Claude, OpenAI, Gemini, and Perplexity, both from model memory and with live web search. It then reports the mention rate with confidence intervals, average position, position-weighted share of voice, and a competitor leaderboard.

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

## Using it

1. Fill in the sentence on the home page: *Does AI recommend **[brand]** when people ask about **[category]**?* Add aliases (other names that count as the brand, e.g. `Google Docs` for Google Workspace) and competitors you want tracked even at zero mentions.
2. **Draft questions** generates a battery of buyer-intent questions. You can edit, add, or remove any of them. A question that names the brand is flagged and excluded.
3. Choose models (the defaults are picked live from OpenRouter's `/models` catalog) and the sample count. The call count and estimated cost update as you change them.
4. **Run the check.** Progress streams in, and metrics update as answers land. When the run finishes you get the verdict, the model × track heatmap, the memory-vs-web gap, the competitor leaderboard, and a drilldown into every answer with the brand highlighted.
5. Every run is saved to **History**. **Export raw rows (CSV)** gives one line per question × model × track × sample.

---

## Methodology

### Why questions never name the brand

The point is to measure **unprompted recommendation**: does the model bring up the brand on its own when a buyer describes a need? If the question names the brand ("Is Notion good for teams?"), the answer will mention it every time, and the mention rate measures nothing. So:

- **The generator never sees the brand.** The first pass sends only the category and the intent slots, so the battery can't be tilted toward or away from the target, even unintentionally.
- **Every question is validated in code** (`leaksBrand` in `lib/scoring.ts`). A question is rejected if it contains the brand or any alias, case-insensitively, with any spacing or hyphenation ("Google Docs", "google-docs", "GoogleDocs"). For names of 4+ characters, any token that contains the name also counts ("NotionHQ", "#notion"). This check is deliberately over-eager.
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

All of this lives in `lib/scoring.ts`, a pure module with unit tests.

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
| **Leaderboard** | Every brand's mention rate (with CI), average position, and SoV over the same answers | Puts the target's number in context. User-listed competitors appear even at zero. |

Every metric is broken down **by model**, **by track**, and **by model × track** (the heatmap), and by question in the drilldown.

**The memory vs. web gap** is computed only over models that ran *both* tracks, so web-only Perplexity can't skew it. It's reported per model and pooled, with a two-proportion z-test. If the gap isn't significant at this sample size, the app says so rather than implying a finding. A large positive gap means current web content surfaces the brand more than training data does, which is a signal that recent content and PR are working. A negative gap means the brand's visibility is mostly historical.

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
lib/
  scoring.ts                 pure: matcher, ranking, Wilson, SoV, breakdowns, leaderboard, verdicts
  scoring.test.ts            vitest suite (matcher edge cases, statistics, aggregation)
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

**CSV columns:** `run_id, question_idx, question, intent, model, track, sample, status, failed_stage, error, target_mentioned, target_rank, match_source, brands_ranked, answer, citations, cost_usd, cached`.

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
- **Cost is estimated.** The pre-run figure uses average token counts. Actual per-row cost comes from OpenRouter usage accounting and is shown during the run.
