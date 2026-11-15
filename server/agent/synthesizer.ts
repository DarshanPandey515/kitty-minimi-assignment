import { ai, MODEL_ROUTER, MODEL_SYNTH, parseJson, thinkingConfig } from "./gemini.js";
import type { Plan } from "./router.js";
import type { Turn } from "../db/queries.js";
import { webSearch, webSearchDecl, type SearchResult } from "./tools/webSearch.js";
import { z } from "zod";
import { recallDecisionSystemPrompt, synthesizerSystemPrompt } from "./prompts.js";

export const MAX_SEARCHES = 6;
// The model sees exactly one tool.
export const TOOLS = [{ functionDeclarations: [webSearchDecl] }] as any;

const RecallDecisionSchema = z.object({
  action: z.enum(["answer", "recall"]),
  query: z.string(),
}).strict();

const recallDecisionResponseSchema = {
  type: "OBJECT",
  properties: {
    action: { type: "STRING", enum: ["answer", "recall"] },
    query: { type: "STRING" },
  },
  required: ["action", "query"],
};

export async function decideRecall(args: {
  plan: Plan;
  memoryBlock: string;
  userMessage: string;
}): Promise<z.infer<typeof RecallDecisionSchema>> {
  const response = await ai.models.generateContent({
    model: MODEL_ROUTER(),
    contents: [{ role: "user", parts: [{ text: JSON.stringify({ intent: args.plan.intent, entities: args.plan.entities, message: args.userMessage }) }] }],
    config: {
      systemInstruction: recallDecisionSystemPrompt(args.memoryBlock),
      temperature: 0,
      maxOutputTokens: 60,
      responseMimeType: "application/json",
      responseSchema: recallDecisionResponseSchema,
      thinkingConfig,
    },
  });
  return RecallDecisionSchema.parse(parseJson(response.text ?? ""));
}

export async function synthesize(args: {
  plan: Plan;
  memoryBlock: string;
  history: Turn[];
  userMessage: string;
  onToken: (t: string) => void;
  onSearch: (q: string, results?: SearchResult[]) => void;
}): Promise<{ text: string }> {
  const contents: any[] = [
    ...args.history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    { role: "user", parts: [{ text: args.userMessage }] },
  ];
  const system = synthesizerSystemPrompt(args.plan, args.memoryBlock);
  let searches = 0;
  let full = "";

  for (let step = 0; step <= MAX_SEARCHES; step++) {
    const stream = await ai.models.generateContentStream({
      model: MODEL_SYNTH(),
      contents,
      config: { systemInstruction: system, temperature: 0.3, tools: searches < MAX_SEARCHES ? TOOLS : undefined, thinkingConfig },
    });

    const parts: any[] = [];
    const calls: { name: string; args: { query?: string } }[] = [];
    let turnText = "";

    for await (const chunk of stream) {
      for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
        parts.push(p);
        if (p.functionCall) { calls.push(p.functionCall as any); continue; }
        if (!p.text) continue;
        turnText += p.text;
        args.onToken(p.text);
      }
    }

    if (calls.length) {
      full += turnText;
      contents.push({ role: "model", parts });
      const responses: any[] = [];
      for (const call of calls) {
        const q = String(call.args?.query ?? "");
        let results: SearchResult[] = [];
        if (call.name === "web_search" && q && searches < MAX_SEARCHES) {
          searches++;
          args.onSearch(q);
          results = await webSearch(q);
          args.onSearch(q, results);
        }
        responses.push({
          functionResponse: {
            name: call.name,
            response: { results: results.map((r) => ({ ...r, published_at: r.published_at ?? "undated" })), note: results.length ? undefined : "no results (search failed or empty)" },
          },
        });
      }
      contents.push({ role: "user", parts: responses });
      continue;
    }

    return { text: full + turnText };
  }
  return { text: full };
}
