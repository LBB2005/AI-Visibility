import crypto from "node:crypto";
import { db } from "./db";

const BASE = "https://openrouter.ai/api/v1";
const MAX_IN_FLIGHT = 4;
const MAX_ATTEMPTS = 5;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  plugins?: { id: string; max_results?: number; engine?: string }[];
  response_format?: unknown;
  reasoning?: { effort?: string; exclude?: boolean };
  max_tokens?: number;
  temperature?: number;
}

export interface ChatResult {
  text: string;
  model: string;
  cost: number | null;
  citations: { url: string; title?: string }[];
  cached: boolean;
  latencyMs: number;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Global concurrency limiter (shared across all runs in this process)
// ---------------------------------------------------------------------------

class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const g = globalThis as unknown as { __avcLimiter?: Limiter };
const limiter = (g.__avcLimiter ??= new Limiter(MAX_IN_FLIGHT));

// ---------------------------------------------------------------------------
// Dev cache: identical request (+ caller-supplied salt, e.g. sample index) → stored response
// ---------------------------------------------------------------------------

const cacheEnabled = () => process.env.AVC_CACHE === "1" || (process.env.AVC_CACHE !== "0" && process.env.NODE_ENV !== "production");

function cacheKey(req: ChatRequest, salt: string) {
  return crypto.createHash("sha256").update(JSON.stringify(req) + "\n" + salt).digest("hex");
}

function cacheGet(key: string): Omit<ChatResult, "cached" | "latencyMs"> | null {
  const row = db().prepare("SELECT value FROM cache WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

function cachePut(key: string, value: Omit<ChatResult, "cached" | "latencyMs">) {
  db().prepare("INSERT OR REPLACE INTO cache (key, value, created_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Chat completion with exponential backoff on 429 / 5xx / network errors
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function apiKey() {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) throw new OpenRouterError("OPENROUTER_API_KEY is not set. Add it to .env.local.");
  return k;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  return "";
}

export async function chat(req: ChatRequest, opts: { cacheSalt?: string; noCache?: boolean } = {}): Promise<ChatResult> {
  const useCache = cacheEnabled() && !opts.noCache;
  const key = useCache ? cacheKey(req, opts.cacheSalt ?? "") : "";
  if (useCache) {
    const hit = cacheGet(key);
    // A cache hit isn't billed: cost is what this call actually spent.
    if (hit) return { ...hit, cost: 0, cached: true, latencyMs: 0 };
  }

  let lastErr: OpenRouterError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const result = await limiter.run(() => once(req));
      if (useCache) cachePut(key, result);
      return { ...result, cached: false, latencyMs: Date.now() - started };
    } catch (e) {
      lastErr = e instanceof OpenRouterError ? e : new OpenRouterError(String((e as Error)?.message ?? e), undefined, true);
      if (!lastErr.retryable || attempt === MAX_ATTEMPTS - 1) break;
      const retryAfter = (lastErr as OpenRouterError & { retryAfterMs?: number }).retryAfterMs;
      const backoff = retryAfter ?? Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      await sleep(backoff);
    }
  }
  throw lastErr ?? new OpenRouterError("Unknown OpenRouter error");
}

async function once(req: ChatRequest): Promise<Omit<ChatResult, "cached" | "latencyMs">> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "AI Visibility Checker",
      },
      body: JSON.stringify({ ...req, usage: { include: true } }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new OpenRouterError(`Network error: ${(e as Error).message}`, undefined, true);
  }

  const bodyText = await res.text();
  let data: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = JSON.parse(bodyText);
  } catch {
    // Non-JSON body (e.g. gateway HTML) — treat by status.
  }

  const retryableStatus = (s: number) => s === 408 || s === 429 || s >= 500;
  if (!res.ok || data.error) {
    const status = Number(data.error?.code) || res.status;
    const msg = data.error?.message ?? (bodyText.slice(0, 300) || `HTTP ${res.status}`);
    const err = new OpenRouterError(`OpenRouter ${status}: ${msg}`, status, retryableStatus(status)) as OpenRouterError & { retryAfterMs?: number };
    const ra = Number(res.headers.get("retry-after"));
    if (ra > 0) err.retryAfterMs = Math.min(ra * 1000, 60_000);
    throw err;
  }

  const choice = data.choices?.[0];
  const text = messageText(choice?.message?.content).trim();
  if (!text) {
    // Empty completions happen (provider hiccups, reasoning ate the budget) — retry.
    throw new OpenRouterError(`Empty response from ${req.model} (finish_reason: ${choice?.finish_reason ?? "unknown"})`, res.status, true);
  }

  const citations: { url: string; title?: string }[] = [];
  for (const a of choice?.message?.annotations ?? []) {
    const c = a?.url_citation;
    if (a?.type === "url_citation" && c?.url && !citations.some((x) => x.url === c.url)) citations.push({ url: c.url, title: c.title });
  }
  for (const url of data.citations ?? []) {
    if (typeof url === "string" && !citations.some((x) => x.url === url)) citations.push({ url });
  }

  return {
    text,
    model: data.model ?? req.model,
    cost: typeof data.usage?.cost === "number" ? data.usage.cost : null,
    citations,
  };
}

/** Pull the first JSON object out of a model response (tolerates code fences / preamble). */
export function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object found");
  return JSON.parse(body.slice(start, end + 1));
}
