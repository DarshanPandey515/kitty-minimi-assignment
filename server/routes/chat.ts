import { Router } from "express";
import { randomUUID } from "node:crypto";
import { runAgent, type AgentEvent } from "../agent/index.js";

export const chatRouter = Router();

chatRouter.post("/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) { res.status(400).json({ error: "message required" }); return; }
  const sessionId = String(req.body?.sessionId || "") || randomUUID();

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "x-session-id": sessionId,
    "Access-Control-Expose-Headers": "x-session-id",
  });
  res.flushHeaders();

  let finished = false;
  const send = (e: AgentEvent) => {
    if (finished || res.writableEnded) return;
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    if (e.type === "done" || e.type === "error") { finished = true; clearTimeout(timer); res.end(); }
  };
  const timer = setTimeout(() => send({ type: "error", data: { message: "timeout after 60s" } }), 60_000);
  res.on("close", () => { finished = true; clearTimeout(timer); });

  try {
    await runAgent({ sessionId, userMessage: message, onEvent: send });
  } catch (err) {
    console.error("[chat]", err);
    send({ type: "error", data: { message: (err as Error).message } });
  }
});
