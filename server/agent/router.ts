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

const FALLBACK_STOP_WORDS = new Set("about after again any are before built did do does ever for from has have how i in is it me my of on or our since that the then there this time to today was we were what when where which who why with you your ask asked tell told talk talked discuss discussed".split(" "));

function fallbackPlan(utterance: string, resolvedDateRange: [string, string] | null, recentEntities: string[]): Plan {
  const priorReference = /\b(?:did i (?:ever )?ask(?:ed)?|what did i ask|last time|last week|earlier (?:we|i)|previously (?:we|i)|prior conversation|previous chat|we discussed|we talked|did we discuss|did we talk|since then|before)\b/i.test(utterance);
  const temporal = priorReference && /\b(changed?|still|current|pricing|price|since then|same|correct)\b/i.test(utterance);
  const intent: Plan["intent"] = resolvedDateRange ? "recall" : temporal ? "temporal_delta" : priorReference ? "recall" : "chat";
  let entities = recentEntities;
  if (!entities.length) {
    const subject = utterance.match(/\b(?:about|regarding|for)\s+([^?.,!]+)/i)?.[1];
    const terms = (subject ?? utterance).toLowerCase().match(/[a-z0-9][a-z0-9.-]*/g) ?? [];
    entities = [...new Set(terms.filter((term) => term.length > 2 && !FALLBACK_STOP_WORDS.has(term)))].slice(-4);
  }
  const search = intent === "temporal_delta" || (intent === "chat" && /^(who|what|when|where|why|how)\b/i.test(utterance));
  return {
    intent,
    entities,
    date_range: resolvedDateRange,
    needs_memory: intent === "recall" || intent === "temporal_delta",
    needs_web: search,
    search_queries: search ? [utterance] : [],
  };
}

export async function route(
  utterance: string,
  resolvedDateRange: [string, string] | null,
  recentEntities: string[],
): Promise<Plan> {
  const fallback = fallbackPlan(utterance, resolvedDateRange, recentEntities);
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
