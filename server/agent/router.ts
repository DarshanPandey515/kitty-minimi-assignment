import { z } from "zod";
import { ai, MODEL_ROUTER, thinkingConfig, parseJson } from "./gemini.js";
import { ROUTER_SYSTEM_PROMPT } from "./prompts.js";

export const PlanSchema = z.object({
  intent: z.enum(["chat", "search", "recall", "temporal_delta"]),
  entities: z.array(z.string()).default([]),
  date_range: z.tuple([z.string(), z.string()]).nullable().default(null),
  needs_memory: z.boolean(),
  needs_web: z.boolean(),
  search_queries: z.array(z.string()).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

export async function route(
  utterance: string,
  resolvedDateRange: [string, string] | null,
  recentEntities: string[],
): Promise<Plan> {
  const fallback: Plan = {
    intent: resolvedDateRange ? "recall" : "chat",
    entities: recentEntities,
    date_range: resolvedDateRange,
    needs_memory: !!resolvedDateRange,
    needs_web: true,
    search_queries: [],
  };
  try {
    const res = await ai.models.generateContent({
      model: MODEL_ROUTER(),
      contents: [{ role: "user", parts: [{ text: JSON.stringify({ utterance, resolvedDateRange, recentEntities }) }] }],
      config: { systemInstruction: ROUTER_SYSTEM_PROMPT, temperature: 0, responseMimeType: "application/json", thinkingConfig },
    });
    const plan = PlanSchema.parse(parseJson(res.text ?? ""));
    if (resolvedDateRange) plan.date_range = resolvedDateRange; // code owns date math
    return plan;
  } catch (err) {
    console.error("[router] fallback:", (err as Error).message);
    return fallback;
  }
}
