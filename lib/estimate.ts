/**
 * Pure call-count and cost estimate, shared by the client (pre-run) and server (stored on the run).
 * Token counts are rough averages observed for buyer-intent answers; the estimate is an
 * order-of-magnitude guide, and actual cost (from OpenRouter usage) is tracked per row.
 */

export interface PricedModel {
  id: string;
  webNative: boolean;
  promptPrice: number; // per token
  completionPrice: number; // per token
  webSearchPrice: number; // per request
}

export const EST = {
  questionTokens: 40,
  answerTokens: 900, // visible answer + typical reasoning overhead
  listAnswerTokens: 2600, // a ranked list of ~50 names runs far longer
  listExtractPromptTokens: 3800,
  listExtractCompletionTokens: 900,
  webContextTokens: 25000, // injected search results (observed ~25k with native search)
  extractPromptTokens: 1400,
  extractCompletionTokens: 200,
  defaultWebSearchPrice: 0.01,
  searchesPerWebAnswer: 2, // models often issue more than one search per answer
};

export function tracksFor(m: { webNative: boolean }): ("parametric" | "web")[] {
  return m.webNative ? ["web"] : ["parametric", "web"];
}

/** One planned question: its kind decides answer length, and it may override samples. */
export interface QuestionSpec {
  kind?: "buyer" | "list";
  samples?: number;
}

export function estimate(opts: { questions: QuestionSpec[]; samples: number; models: PricedModel[]; extractor: PricedModel | null }) {
  let answerCalls = 0;
  let cost = 0;
  for (const q of opts.questions) {
    const isList = q.kind === "list";
    const reps = Math.max(1, q.samples ?? opts.samples);
    const answerTokens = isList ? EST.listAnswerTokens : EST.answerTokens;
    const exPrompt = isList ? EST.listExtractPromptTokens : EST.extractPromptTokens;
    const exCompletion = isList ? EST.listExtractCompletionTokens : EST.extractCompletionTokens;
    for (const m of opts.models) {
      for (const track of tracksFor(m)) {
        answerCalls += reps;
        const promptTokens = EST.questionTokens + (track === "web" ? EST.webContextTokens : 0);
        let per = promptTokens * m.promptPrice + answerTokens * m.completionPrice;
        // Plugin web search is billed per request; native-search models (Perplexity) bill search per request too.
        if (track === "web") per += (m.webSearchPrice || EST.defaultWebSearchPrice) * EST.searchesPerWebAnswer;
        if (opts.extractor) per += exPrompt * opts.extractor.promptPrice + exCompletion * opts.extractor.completionPrice;
        cost += per * reps;
      }
    }
  }
  return { answerCalls, extractCalls: answerCalls, totalCalls: answerCalls * 2, cost };
}
