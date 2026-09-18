import type { RunModel } from "./db";

/** Subset of an OpenRouter /models entry that we use. */
export interface CatalogModel {
  id: string;
  name: string;
  created: number;
  promptPrice: number; // USD per token
  completionPrice: number; // USD per token
  webSearchPrice: number; // USD per search request (0 if unknown)
  supportsStructured: boolean;
}

export const PROVIDERS = [
  { provider: "anthropic", label: "Claude" },
  { provider: "openai", label: "OpenAI" },
  { provider: "google", label: "Gemini" },
  { provider: "perplexity", label: "Perplexity" },
] as const;

/** Models that always search the web — they have no parametric track. */
export const isWebNative = (id: string) => id.startsWith("perplexity/");

// Variants that aren't the "default chat model" a typical user would hit.
const EXCLUDE = /(:batch|:free|:extended|:thinking|-pro\b|-pro-|image|audio|tts|vision|embed|deep-research|reasoning|-search|nano|lite|preview|exp|customtools|codex|oss|gemma|guard)/i;
// Mid-tier price ceiling: keeps defaults on the models most people actually get
// (Sonnet-class / Flash-class) instead of the newest $10+/M flagships.
const DEFAULT_MAX_PROMPT_PER_M = 3;

let cache: { at: number; models: CatalogModel[] } | null = null;

export async function fetchCatalog(): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.at < 60 * 60 * 1000) return cache.models;
  const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const json = (await res.json()) as { data: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const models: CatalogModel[] = json.data
    .filter((m) => {
      const out: string[] = m.architecture?.output_modalities ?? ["text"];
      return out.length === 1 && out[0] === "text";
    })
    .map((m) => ({
      id: m.id,
      name: m.name,
      created: m.created ?? 0,
      promptPrice: Number(m.pricing?.prompt ?? 0),
      completionPrice: Number(m.pricing?.completion ?? 0),
      webSearchPrice: Number(m.pricing?.web_search ?? 0),
      supportsStructured: (m.supported_parameters ?? []).some((p: string) => p === "structured_outputs" || p === "response_format"),
    }));
  cache = { at: Date.now(), models };
  return models;
}

const perM = (m: CatalogModel) => m.promptPrice * 1e6;

/**
 * Default pick per provider: the newest general chat model under the price ceiling,
 * excluding batch/pro/image/lite/deep-research variants. Ties (same release date)
 * go to the pricier — i.e. more capable — tier.
 */
export function pickDefault(models: CatalogModel[], provider: string): CatalogModel | null {
  const pool = models.filter((m) => m.id.startsWith(provider + "/") && !EXCLUDE.test(m.id) && perM(m) > 0 && perM(m) <= DEFAULT_MAX_PROMPT_PER_M);
  const day = (m: CatalogModel) => Math.floor(m.created / 86400);
  pool.sort((a, b) => day(b) - day(a) || b.promptPrice - a.promptPrice || b.completionPrice - a.completionPrice || a.id.localeCompare(b.id));
  return pool[0] ?? null;
}

/** Cheap, structured-output-capable model for the extraction pass. */
export function pickExtractor(models: CatalogModel[]): CatalogModel | null {
  const pool = models.filter(
    (m) =>
      ["openai/", "google/", "anthropic/"].some((p) => m.id.startsWith(p)) &&
      m.supportsStructured &&
      !/(:batch|:free|image|audio|-pro\b|preview|gemma|oss|codex)/i.test(m.id) &&
      perM(m) > 0 &&
      perM(m) <= 0.5,
  );
  pool.sort((a, b) => b.created - a.created || a.promptPrice - b.promptPrice);
  return pool[0] ?? null;
}

export function toRunModel(m: CatalogModel): RunModel {
  const provider = m.id.split("/")[0];
  const label = PROVIDERS.find((p) => p.provider === provider)?.label ?? provider;
  return { id: m.id, label: `${label} · ${m.name.replace(/^[^:]+:\s*/, "")}`, provider, webNative: isWebNative(m.id) };
}
