import { ai, MODEL_SYNTH, thinkingConfig } from "./gemini.js";
import type { Plan } from "./router.js";
import type { Turn } from "../db/queries.js";
import { webSearch, webSearchDecl, type SearchResult } from "./tools/webSearch.js";
import { todayLabel } from "../time.js";

export const MAX_SEARCHES = 6;
// The model sees exactly one tool.
export const TOOLS = [{ functionDeclarations: [webSearchDecl] }] as any;

function systemPrompt(plan: Plan, memoryBlock: string, allowRecall: boolean) {
  return `Today is ${todayLabel()}. You may only use the web_search tool. Do not fabricate URLs or dates.
Intent: ${plan.intent}. Entities: ${plan.entities.join(", ") || "none"}.
${plan.search_queries.length ? `Suggested searches: ${plan.search_queries.join(" | ")}` : ""}

- If intent is "recall", answer only from <memory>; quote the prior user message exactly. If it is absent, say so plainly. Never invent turns.
- If intent is "temporal_delta": for each entity, compare the dated prior claim against fresh search evidence. Lead with the answer (e.g. "Yes — 2 of 5 changed:"). For each entity say changed / not changed / unverified, citing url and published_at. If a source has no date, write "undated". Never invent a date.
- If the user asks whether an earlier answer is still correct, recall it from <memory> and then verify it with web_search.
${allowRecall
    ? `- Escape hatch: if a past claim you need is absent from <memory>, output exactly {"need_recall": "<query>"} and nothing else. Do not guess.`
    : `- Do not output need_recall. Answer with what you have and state plainly what is missing.`}

${memoryBlock}`;
}

export async function synthesize(args: {
  plan: Plan;
  memoryBlock: string;
  history: Turn[];
  userMessage: string;
  allowRecall: boolean;
  onToken: (t: string) => void;
  onSearch: (q: string, results?: SearchResult[]) => void;
}): Promise<{ text: string; needRecall?: string }> {
  const contents: any[] = [
    ...args.history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    { role: "user", parts: [{ text: args.userMessage }] },
  ];
  const system = systemPrompt(args.plan, args.memoryBlock, args.allowRecall);
  const PREFIX = '{"need_recall"';
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
    let turnText = "", decided = false, suppress = false;

    for await (const chunk of stream) {
      for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
        parts.push(p);
        if (p.functionCall) { calls.push(p.functionCall as any); continue; }
        if (!p.text) continue;
        turnText += p.text;
        if (!decided) {
          const s = turnText.trimStart();
          if (s.length < PREFIX.length) continue; // hold back until we can tell if it's the escape hatch
          decided = true;
          suppress = args.allowRecall && s.startsWith(PREFIX);
          if (!suppress) args.onToken(turnText);
        } else if (!suppress) args.onToken(p.text);
      }
    }
    if (!decided && turnText && !suppress) args.onToken(turnText); // short reply

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

    if (args.allowRecall) {
      const m = turnText.match(/\{\s*"need_recall"\s*:\s*"([^"]*)"\s*\}/);
      if (m && turnText.trimStart().startsWith(PREFIX)) return { text: "", needRecall: m[1] };
    }
    return { text: full + turnText };
  }
  return { text: full };
}
