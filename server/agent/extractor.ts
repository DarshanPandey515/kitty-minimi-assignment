import { z } from "zod";
import { ai, MODEL_EXTRACT, thinkingConfig, parseJson } from "./gemini.js";
import { getTurn, writeExtraction, lastTurns, pendingExtractions, retryTurnExtraction } from "../db/queries.js";
import { EXTRACTOR_SYSTEM_PROMPT } from "./prompts.js";

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

const active = new Set<string>();
let workerStarted = false;

/** Fire-and-forget after the response completes. Idempotent per turn_id. */
export async function extract(turnId: string): Promise<void> {
  if (active.has(turnId)) return;
  active.add(turnId);
  try {
    const turn = getTurn(turnId);
    if (!turn) return;
    // Extract from the assistant turn plus the user message that triggered it.
    const prev = lastTurns(turn.session_id, 3).filter((t) => t.ts <= turn.ts);
    const text = prev.map((t) => `${t.role}: ${t.text}`).join("\n\n");
    const res = await ai.models.generateContent({
      model: MODEL_EXTRACT(),
      contents: [{ role: "user", parts: [{ text }] }],
      config: { systemInstruction: EXTRACTOR_SYSTEM_PROMPT, temperature: 0, responseMimeType: "application/json", thinkingConfig },
    });
    const parsed = ExtractionSchema.parse(parseJson(res.text ?? "{}"));
    writeExtraction(turnId, parsed.entities, parsed.claims.map((c) => ({ ...c, source_url: c.source_url ?? null, as_of: c.as_of || turn.ts })));
  } catch (err) {
    const turn = getTurn(turnId);
    if (turn) retryTurnExtraction(turnId, turn.extraction_attempts ?? 0);
    console.warn("[extractor] retry scheduled after failure:", (err as Error).message);
  } finally {
    active.delete(turnId);
  }
}

/** Retries failed and legacy-unprocessed assistant turns without blocking chat startup. */
export function startClaimExtractionWorker() {
  if (workerStarted) return;
  workerStarted = true;
  const timer = setInterval(() => void drainExtractions(), 5_000);
  timer.unref();
  console.info("[extractor] background retry worker enabled");
  void drainExtractions();
}

async function drainExtractions() {
  for (const turn of pendingExtractions(2)) await extract(turn.id);
}
