import { z } from "zod";
import { ai, MODEL_EXTRACT, thinkingConfig, parseJson } from "./gemini.js";
import { getTurn, writeExtraction, lastTurns } from "../db/queries.js";

const ExtractionSchema = z.object({
  entities: z.array(z.string()).default([]),
  claims: z.array(z.object({
    entity: z.string(),
    attribute: z.string(),
    value: z.string(),
    source_url: z.string().nullable().default(null),
    as_of: z.string().optional(),
  })).default([]),
});

const SYSTEM = `Extract durable factual claims a future turn could re-verify. Skip small talk, opinions, and anything without an attributable attribute (e.g. "pricing", "free tier limit").
Return JSON: {"entities":[string], "claims":[{"entity","attribute","value","source_url"|null,"as_of"?}]}
- entities: named things discussed in this turn (products, companies), including ones only mentioned by the user.
- source_url: only if a URL appears in the text; never invent one.
- as_of: ISO date when the claim was true; omit if unknown.`;

/** Fire-and-forget after the response completes. Idempotent per turn_id. */
export async function extract(turnId: string): Promise<void> {
  try {
    const turn = getTurn(turnId);
    if (!turn) return;
    // Extract from the assistant turn plus the user message that triggered it.
    const prev = lastTurns(turn.session_id, 3).filter((t) => t.ts <= turn.ts);
    const text = prev.map((t) => `${t.role}: ${t.text}`).join("\n\n");
    const res = await ai.models.generateContent({
      model: MODEL_EXTRACT(),
      contents: [{ role: "user", parts: [{ text }] }],
      config: { systemInstruction: SYSTEM, temperature: 0, responseMimeType: "application/json", thinkingConfig },
    });
    const parsed = ExtractionSchema.parse(parseJson(res.text ?? "{}"));
    writeExtraction(turnId, parsed.entities, parsed.claims.map((c) => ({ ...c, source_url: c.source_url ?? null, as_of: c.as_of || turn.ts })));
  } catch (err) {
    console.error("[extractor]", (err as Error).message);
  }
}
