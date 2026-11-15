import { ensureSession, insertTurn, lastEntities, lastTurns, claimsByEntityOrText, type Turn } from "../db/queries.js";
import { resolveRelative } from "../time.js";
import { route, type Plan } from "./router.js";
import { prefetchWithStats } from "./prefetch.js";
import { synthesize } from "./synthesizer.js";
import { extract } from "./extractor.js";

export type AgentEvent =
  | { type: "plan"; data: { intent: Plan["intent"]; entities: string[]; dateRange: [string, string] | null } }
  | { type: "memory"; data: { turnCount: number; claimCount: number } }
  | { type: "tool"; data: { query: string; results?: { title: string; url: string; published_at: string | null }[] } }
  | { type: "token"; data: { text: string } }
  | { type: "done"; data: { turnId: string } }
  | { type: "error"; data: { message: string } };

export async function runAgent(args: { sessionId: string; userMessage: string; onEvent: (e: AgentEvent) => void }): Promise<void> {
  const { sessionId, userMessage, onEvent } = args;
  ensureSession(sessionId);

  const history: Turn[] = lastTurns(sessionId, 10); // before inserting the current message
  insertTurn(sessionId, "user", userMessage); // 1

  const dateRange = resolveRelative(userMessage); // 2
  const plan = await route(userMessage, dateRange, lastEntities(sessionId)); // 3
  onEvent({ type: "plan", data: { intent: plan.intent, entities: plan.entities, dateRange: plan.date_range } });

  const pre = await prefetchWithStats(plan, sessionId); // 4
  onEvent({ type: "memory", data: { turnCount: pre.turnCount, claimCount: pre.claimCount } });

  // 5. synthesize with bounded escape hatch (max 1 retry)
  const run = (memoryBlock: string, allowRecall: boolean) =>
    synthesize({
      plan, memoryBlock, history, userMessage, allowRecall,
      onToken: (text) => onEvent({ type: "token", data: { text } }),
      onSearch: (query, results) =>
        onEvent({
          type: "tool",
          data: results
            ? { query, results: results.map(({ title, url, published_at }) => ({ title, url, published_at })) }
            : { query },
        }),
    });

  let out = await run(pre.block, true);
  if (out.needRecall) {
    const extra = claimsByEntityOrText(out.needRecall);
    const lines = extra.map((c) => `  { entity: ${JSON.stringify(c.entity)}, attribute: ${JSON.stringify(c.attribute)}, value: ${JSON.stringify(c.value)}, source: ${JSON.stringify(c.source_url ?? "unknown")}, as_of: "${c.as_of.slice(0, 10)}" }`);
    const memory2 = pre.block.replace("</memory>", `\nRecalled on request ("${out.needRecall}"):\n${lines.join("\n") || "  (nothing found)"}\n</memory>`);
    onEvent({ type: "memory", data: { turnCount: pre.turnCount, claimCount: pre.claimCount + extra.length } });
    out = await run(memory2, false); // forced plain answer, no second retry
  }

  const assistant = insertTurn(sessionId, "assistant", out.text); // 6
  onEvent({ type: "done", data: { turnId: assistant.id } });
  void extract(assistant.id); // 7 async
}
