import { ensureSession, insertTurn, lastEntities, lastTurns, claimsByEntityOrText, writeExtraction, type Turn } from "../db/queries.js";
import { resolveRelative } from "../time.js";
import { route, type Plan } from "./router.js";
import { formatPriorTurn, isInternalAssistantText, prefetchWithStats } from "./prefetch.js";
import { decideRecall, synthesize } from "./synthesizer.js";
import { extract } from "./extractor.js";
import { retrieveMemory } from "./memory.js";

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

  const history: Turn[] = lastTurns(sessionId, 10).filter((t) => t.role !== "assistant" || !isInternalAssistantText(t.text)); // before inserting the current message
  const currentTurn = insertTurn(sessionId, "user", userMessage); // 1

  const dateRange = resolveRelative(userMessage); // 2
  const plan = await route(userMessage, dateRange, lastEntities(sessionId)); // 3
  if (plan.entities.length && plan.intent !== "recall" && plan.intent !== "temporal_delta") {
    writeExtraction(currentTurn.id, plan.entities, plan.entities.map((entity) => ({
      entity,
      attribute: "conversation topic",
      value: `User asked: ${userMessage}`,
      source_url: null,
      as_of: currentTurn.ts,
    })));
  }
  onEvent({ type: "plan", data: { intent: plan.intent, entities: plan.entities, dateRange: plan.date_range } });

  const pre = await prefetchWithStats(plan, sessionId); // 4
  onEvent({ type: "memory", data: { turnCount: pre.turnCount, claimCount: pre.claimCount } });

  let memoryBlock = pre.block;
  if (plan.intent === "recall" || plan.intent === "temporal_delta") {
    try {
      const recentIds = new Set(history.map((turn) => turn.id));
      const recalledTurns = await retrieveMemory({
        sessionId,
        query: userMessage,
        intent: plan.intent,
        dateRange: plan.date_range,
        excludeTurnIds: [currentTurn.id, ...recentIds],
      });
      const filteredRecalledTurns = recalledTurns
        .filter((turn) => turn.id !== currentTurn.id && !recentIds.has(turn.id))
        .filter((turn) => turn.role !== "assistant" || !isInternalAssistantText(turn.text));
      if (filteredRecalledTurns.length) {
        memoryBlock = memoryBlock.replace("</memory>", `\nRelevant matching prior turns:\n${filteredRecalledTurns.map(formatPriorTurn).join("\n")}\n</memory>`);
      }
      const decision = await decideRecall({ plan, memoryBlock, userMessage });
      if (decision.action === "recall") {
        const extra = claimsByEntityOrText(decision.query || userMessage);
        const lines = extra.map((c) => `  { entity: ${JSON.stringify(c.entity)}, attribute: ${JSON.stringify(c.attribute)}, value: ${JSON.stringify(c.value)}, source: ${JSON.stringify(c.source_url ?? "unknown")}, as_of: "${c.as_of.slice(0, 10)}" }`);
        memoryBlock = memoryBlock.replace("</memory>", `\nAdditional recalled claims:\n${lines.join("\n") || "  (nothing found)"}\n</memory>`);
        onEvent({ type: "memory", data: { turnCount: pre.turnCount, claimCount: pre.claimCount + extra.length } });
        await decideRecall({ plan, memoryBlock, userMessage }); // one bounded recall retry
      }
    } catch (err) {
      console.error("[recall decision] fail open:", (err as Error).message);
    }
  }

  const out = await synthesize({
    plan, memoryBlock, history, userMessage,
    onToken: (text) => onEvent({ type: "token", data: { text } }),
    onSearch: (query, results) =>
      onEvent({
        type: "tool",
        data: results
          ? { query, results: results.map(({ title, url, published_at }) => ({ title, url, published_at })) }
          : { query },
      }),
  });

  const assistant = insertTurn(sessionId, "assistant", out.text); // 6
  onEvent({ type: "done", data: { turnId: assistant.id } });
  void extract(assistant.id); // 7 async
}
