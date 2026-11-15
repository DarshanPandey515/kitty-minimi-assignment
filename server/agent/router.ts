import { z } from "zod";
import { ai, MODEL_ROUTER, thinkingConfig, parseJson } from "./gemini.js";

export const PlanSchema = z.object({
  intent: z.enum(["chat", "search", "recall", "temporal_delta"]),
  entities: z.array(z.string()).default([]),
  date_range: z.tuple([z.string(), z.string()]).nullable().default(null),
  needs_memory: z.boolean(),
  needs_web: z.boolean(),
  search_queries: z.array(z.string()).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

const SYSTEM = `You classify the user's next turn. You never answer it.
Return JSON: {"intent":"chat|search|recall|temporal_delta","entities":[],"date_range":[start,end]|null,"needs_memory":bool,"needs_web":bool,"search_queries":[]}
- temporal_delta = user references a prior conversation AND asks whether something changed / is still correct.
- recall = user asks what was said or asked previously (no web needed unless they also ask if it's still correct).
- search = fresh factual lookup with no dependence on earlier turns.
- chat = everything else.
- Populate search_queries for temporal_delta/search: one per entity + attribute (e.g. "HubSpot CRM pricing change 2025").
- entities: concrete named things (products, companies). Use recentEntities if the user says "them"/"those".
- If resolvedDateRange is given, echo it exactly as date_range; otherwise null.
- needs_memory is true for recall and temporal_delta.`;

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
      config: { systemInstruction: SYSTEM, temperature: 0, responseMimeType: "application/json", thinkingConfig },
    });
    const plan = PlanSchema.parse(parseJson(res.text ?? ""));
    if (resolvedDateRange) plan.date_range = resolvedDateRange; // code owns date math
    return plan;
  } catch (err) {
    console.error("[router] fallback:", (err as Error).message);
    return fallback;
  }
}
