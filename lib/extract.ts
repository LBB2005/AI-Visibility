import { z } from "zod";
import { chat, parseJsonObject } from "./openrouter";

export const ExtractionSchema = z.object({
  brands: z.array(
    z.object({
      name: z.string().min(1),
      first_position: z.number().int().min(1),
    }),
  ),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

const JSON_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "brand_mentions",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["brands"],
      properties: {
        brands: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "first_position"],
            properties: { name: { type: "string" }, first_position: { type: "integer" } },
          },
        },
      },
    },
  },
};

const INSTRUCTIONS = `You extract brand mentions from an AI assistant's answer.

List every company, product, app, or service that the answer names, in order of first appearance.
- One entry per distinct product/company, using the name exactly as written in the answer.
- first_position is the 1-based order of first appearance (1 = named first).
- Do not include generic categories ("note-taking app"), people, programming languages, or file formats.
- Do not include websites/publications that only appear as cited sources or links.
- If nothing is named, return {"brands": []}.

Return only JSON matching: {"brands":[{"name":string,"first_position":integer}]}`;

/**
 * Separate, cheap extraction call. Strict JSON validated with zod; one retry on
 * bad JSON/validation failure. Throws if both attempts fail (the row is then
 * recorded as failed and excluded from denominators).
 */
export async function extractBrands(answer: string, model: string): Promise<{ brands: Extraction["brands"]; cost: number }> {
  const content = `${INSTRUCTIONS}\n\n<answer>\n${answer.slice(0, 24_000)}\n</answer>`;
  let cost = 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await chat(
        {
          model,
          messages: [
            { role: "user", content: attempt === 0 ? content : `${content}\n\nYour previous reply was not valid JSON for this schema. Reply with the JSON object only.` },
          ],
          response_format: JSON_SCHEMA,
          reasoning: { effort: "low" },
        },
        { noCache: attempt > 0 },
      );
      cost += res.cost ?? 0;
      const parsed = ExtractionSchema.parse(parseJsonObject(res.text));
      return { brands: parsed.brands, cost };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
