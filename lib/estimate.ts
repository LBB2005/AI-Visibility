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
  webContextTokens: 3000, // injected search results
  extractPromptTokens: 1400,
  extractCompletionTokens: 200,
  defaultWebSearchPrice: 0.01,
  searchesPerWebAnswer: 2, // models often issue more than one search per answer
};

export function tracksFor(m: { webNative: boolean }): ("parametric" | "web")[] {
  return m.webNative ? ["web"] : ["parametric", "web"];
}

export function estimate(opts: { questions: number; samples: number; models: PricedModel[]; extractor: PricedModel | null }) {
  let answerCalls = 0;
  let cost = 0;
  for (const m of opts.models) {
    for (const track of tracksFor(m)) {
      const n = opts.questions * opts.samples;
      answerCalls += n;
      const promptTokens = EST.questionTokens + (track === "web" ? EST.webContextTokens : 0);
      let per = promptTokens * m.promptPrice + EST.answerTokens * m.completionPrice;
      // Plugin web search is billed per request; native-search models (Perplexity) bill search per request too.
      if (track === "web") per += (m.webSearchPrice || EST.defaultWebSearchPrice) * EST.searchesPerWebAnswer;
      cost += per * n;
    }
  }
  const extractCalls = answerCalls;
  if (opts.extractor) {
    cost += extractCalls * (EST.extractPromptTokens * opts.extractor.promptPrice + EST.extractCompletionTokens * opts.extractor.completionPrice);
  }
  return { answerCalls, extractCalls, totalCalls: answerCalls + extractCalls, cost };
}
