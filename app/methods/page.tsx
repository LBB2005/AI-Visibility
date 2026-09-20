import Link from "next/link";
import { MIN_LIFT_ANSWERS } from "@/lib/citations";

export const metadata = { title: "Methods · AI Visibility Checker", description: "How every number in this app is computed, and what it can't tell you." };

function Cite({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="link" href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-14 scroll-mt-6">
      <h2 className="section-title">{title}</h2>
      <div className="mt-3 space-y-3 max-w-[68ch] text-[15px] text-ink-2">{children}</div>
    </section>
  );
}

export default function MethodsPage() {
  return (
    <div className="pt-12 pb-20 reveal">
      <h1 className="display text-[48px] sm:text-[60px] max-w-4xl">How these numbers are computed</h1>
      <p className="mt-4 max-w-[68ch] text-[17px] text-ink-2">
        Every metric in this app is computed in a pure, unit-tested module you can read:{" "}
        <span className="num text-ink">lib/scoring.ts</span>, <span className="num text-ink">lib/stats.ts</span>, and{" "}
        <span className="num text-ink">lib/citations.ts</span>. This page is the short version of what those files do and where the numbers stop being trustworthy.
      </p>

      <Section id="questions" title="Questions never name the brand">
        <p>
          The measurement is <em>unprompted recommendation</em>: does a model bring the brand up on its own when someone describes a need? A question that names the
          brand guarantees a mention and measures nothing, so two rules apply.
        </p>
        <p>
          First, the generator never sees the brand. It gets the category and a list of buyer intents, so the battery can&apos;t be tilted toward or away from the
          target. Second, every question is validated in code: it&apos;s rejected if it contains the brand or any alias, case-insensitively, with any spacing or
          hyphenation (&ldquo;Google Docs&rdquo;, &ldquo;google-docs&rdquo;, &ldquo;GoogleDocs&rdquo;), and for names of four or more characters, if any token
          contains it (&ldquo;NotionHQ&rdquo;). Only a rejected slot is regenerated, and that retry names what to avoid. The same check runs server-side on submit,
          so a hand-edited question can&apos;t slip the brand back in.
        </p>
        <p>
          One intent deliberately names a competitor: &ldquo;alternatives to the market leader&rdquo;. A brand named in the question is the premise, not a
          recommendation, so it&apos;s excluded from that answer&apos;s ranking.
        </p>
      </Section>

      <Section id="tracks" title="Two tracks: memory and live web">
        <p>
          Each model answers each question twice. <strong>Parametric</strong> is the plain model answering from training data. <strong>Web</strong> is the same model
          with OpenRouter&apos;s web plugin, which uses the provider&apos;s native search where one exists and Exa otherwise.
        </p>
        <p>
          Perplexity Sonar always searches, so it has no true parametric track. It runs on the web track only and its parametric cell is marked not applicable
          rather than presented as model memory. The memory-vs-web comparison uses only models that ran both tracks.
        </p>
        <p>
          The question goes as a single plain user message: no system prompt, no format instructions, provider-default sampling. The answer has to be what a real
          user would see, not something shaped by the measurement.
        </p>
      </Section>

      <Section id="matching" title="Deciding whether the brand was named">
        <p>
          A separate, cheap model call reads each answer and returns strict JSON listing every company or product named, validated with zod and retried once. The
          matcher then decides whether any of those names is the target: case-insensitive, on word boundaries. &ldquo;Notion AI&rdquo; counts as Notion; plain
          &ldquo;Notion&rdquo; does not count for a target of &ldquo;Notion AI&rdquo;; &ldquo;Dropbox&rdquo; never matches &ldquo;Box&rdquo;.
        </p>
        <p>
          If extraction misses the brand, a raw-text fallback searches the answer directly, with two guards against common-word brands: an all-lowercase occurrence
          of a capitalized brand is ignored (&ldquo;the notion that…&rdquo;), and names of two characters or fewer never use the fallback. Answers matched only by
          the fallback are counted and shown, so you can audit them.
        </p>
        <p>
          <strong>Position comes from the text, not from the extractor.</strong> Each brand is located by its first occurrence in the answer, which avoids inheriting
          any ordering bias from the extraction model — the kind documented for LLM judges in{" "}
          <Cite href="https://arxiv.org/abs/2306.05685">Zheng et al. (NeurIPS 2023)</Cite>.
        </p>
      </Section>

      <Section id="metrics" title="The metrics">
        <ul className="space-y-3 list-none">
          <li>
            <strong>Mention rate</strong> — share of counted answers naming the brand, <span className="num">k / n</span>. Failed calls are excluded from{" "}
            <span className="num">n</span> and reported separately.
          </li>
          <li>
            <strong>Average position</strong> — the brand&apos;s mean 1-based rank among brands in the answer, over answers that name it.
          </li>
          <li>
            <strong>Share of voice</strong> — position-weighted, with weight <span className="num">1 / log₂(rank + 1)</span>: rank 1 scores 1.00, rank 2 scores 0.63,
            rank 3 scores 0.50. Share of voice is the brand&apos;s total weight divided by the total weight of every brand in the slice, so a long answer listing
            twenty tools doesn&apos;t count for more than a short one.
          </li>
          <li>
            <strong>Leaderboard</strong> — the same metrics for every brand named anywhere in the run, plus any competitor you listed, even at zero.
          </li>
        </ul>
      </Section>

      <Section id="intervals" title="Two confidence intervals, and which to trust">
        <p>
          The headline interval is a <strong>Wilson score interval</strong>, which behaves well near 0% and 100% where the normal approximation breaks down —
          the reason <Cite href="https://arxiv.org/abs/2503.01747">Bowyer et al. (2025)</Cite> recommend it for small-sample evals.
        </p>
        <p>
          But answers are not independent draws. Three samples of the same question, across models and tracks, all share a question, and whether a question elicits
          the brand at all is the biggest source of variance. So a second interval resamples <em>whole questions</em> with replacement (2,000 times, seeded, so the
          number never jitters between page loads) and takes percentiles. <Cite href="https://arxiv.org/abs/2411.00640">Miller (2024)</Cite> shows clustered standard
          errors can be several times the naive ones.
        </p>
        <p>
          The clustered interval is usually the wider and more honest one. When a rate is exactly 0% or 100%, every resample is identical and the interval collapses
          to zero width; the app says so in words instead of printing a fake ±0. The memory-vs-web gap is tested the same way, with a two-sided bootstrap p-value; the
          naive test that ignores clustering is shown next to it for comparison.
        </p>
      </Section>

      <Section id="citations" title="Named versus cited">
        <p>
          On the web track, models return the sources they read. The app resolves each to a registrable domain and sorts it into your site, a competitor&apos;s,
          community and social, review directories, press, reference, or other. Gemini cites through a redirect wrapper, so those are resolved via the citation title
          and counted as unresolved when that fails — never silently credited to Google.
        </p>
        <p>
          A <strong>mention</strong> is the brand appearing in the answer text. A <strong>citation</strong> is the brand&apos;s own domain appearing in that
          answer&apos;s sources. They are different things, and the gap between them is the useful part: being named without being cited means models describe you
          from other people&apos;s pages, while being cited without being named means a model read your site and still recommended someone else.
        </p>
        <p>
          <strong>Lift</strong> for a source compares the brand&apos;s mention rate in answers citing it against answers that don&apos;t. It&apos;s suppressed below{" "}
          {MIN_LIFT_ANSWERS} citing answers, and it is a correlation: a site that already recommends you will correlate with your being named without having caused it.
        </p>
      </Section>

      <Section id="validation" title="Is the extractor right?">
        <p>
          The extraction step is itself a model, so it gets validated rather than trusted. A sample of answers is labeled by hand in a blind interface — the
          model&apos;s output stays server-side until a label is submitted — and the app reports Cohen&apos;s kappa (<Cite href="https://doi.org/10.1177/001316446002000104">Cohen 1960</Cite>)
          on the binary &ldquo;does this answer name the brand&rdquo; decision, alongside raw agreement, prevalence, and precision/recall/F1 on the extracted brand
          sets. Because the gold set skews toward answers that do name a major brand, kappa is reported next to raw agreement and PABAK, which don&apos;t collapse
          under an unbalanced sample. Results live in{" "}
          <span className="num text-ink">gold/validation.md</span>, and a regression test replays the labeled set on every run of the suite.
        </p>
      </Section>

      <Section id="limits" title="What this can't tell you">
        <ul className="space-y-2 list-disc pl-5">
          <li>These are raw model APIs, not ChatGPT or Gemini as consumers use them, which add system prompts, memory, and their own search stacks. Comparisons across brands, models and tracks are far more reliable than the absolute rates.</li>
          <li>Web-track results depend on which search backend a provider uses, so the tracks aren&apos;t perfectly like-for-like across providers.</li>
          <li>More distinct questions buy more precision than more samples of the same question. The clustered interval is what makes that visible.</li>
          <li>Extraction can over- or under-include brands, and every named product counts, including incidental mentions.</li>
          <li>Models and web indexes change. <Cite href="https://arxiv.org/abs/2307.09009">Chen, Zaharia &amp; Zou (2023)</Cite> found large behavior shifts between snapshots of the same model, so every run records the exact model id and date.</li>
        </ul>
      </Section>

      <p className="mt-14">
        <Link href="/" className="btn btn-ghost">
          Run a check
        </Link>
      </p>
    </div>
  );
}
