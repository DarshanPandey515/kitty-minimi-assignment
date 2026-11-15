import type { Plan } from "./router.js";
import { claimsByEntities, lastTurns, recentClaims, turnsInRange, type Claim, type Turn } from "../db/queries.js";
import { todayLabel } from "../time.js";

const MAX_CHARS = 1200 * 4; // ~1200 tokens

export function isInternalAssistantText(text: string) {
  return text.includes("Escape hatch:") || text.includes('{"need_recall"');
}

const fmtTurn = (t: Turn) => `  [${t.ts.slice(0, 16)}Z] ${t.role}: ${JSON.stringify(t.text.length > 400 ? t.text.slice(0, 400) + "…" : t.text)}`;
const fmtClaim = (c: Claim) =>
  `  { entity: ${JSON.stringify(c.entity)}, attribute: ${JSON.stringify(c.attribute)}, value: ${JSON.stringify(c.value)}, source: ${JSON.stringify(c.source_url ?? "unknown")}, as_of: "${c.as_of.slice(0, 10)}" }`;

export function renderMemory(turns: Turn[], claims: Claim[]): string {
  const t = turns.map((x) => ({ ts: x.ts, line: fmtTurn(x) }));
  const c = claims.map((x) => ({ ts: x.as_of, line: fmtClaim(x) }));
  const build = () =>
    `<memory>\nToday: ${todayLabel()}\n\nRecent turns:\n${t.map((x) => x.line).join("\n") || "  (none)"}\n\nYour prior claims (dated):\n${c.map((x) => x.line).join("\n") || "  (none)"}\n</memory>`;
  let out = build();
  // Truncate oldest first (turns before claims)
  while (out.length > MAX_CHARS && (t.length || c.length)) {
    const pool = t.length ? t : c;
    pool.sort((a, b) => a.ts.localeCompare(b.ts));
    pool.shift();
    out = build();
  }
  return out;
}

export async function prefetchWithStats(plan: Plan, sessionId: string) {
  try {
    const tail = lastTurns(sessionId, 10).filter((t) => t.role !== "assistant" || !isInternalAssistantText(t.text));
    const dated = plan.date_range ? turnsInRange(plan.date_range[0], plan.date_range[1]).filter((t) => t.role !== "assistant" || !isInternalAssistantText(t.text)) : [];
    const seen = new Set<string>();
    const turns = [...dated, ...tail].filter((t) => !seen.has(t.id) && seen.add(t.id)).sort((a, b) => a.ts.localeCompare(b.ts));
    let claims = claimsByEntities(plan.entities, 20);
    if (plan.needs_memory && plan.entities.length === 0) claims = recentClaims(14, 20);
    return { block: renderMemory(turns, claims), turnCount: turns.length, claimCount: claims.length };
  } catch (err) {
    console.error("[prefetch]", err);
    return { block: "", turnCount: 0, claimCount: 0 };
  }
}

export async function prefetch(plan: Plan, sessionId: string): Promise<string> {
  return (await prefetchWithStats(plan, sessionId)).block;
}
