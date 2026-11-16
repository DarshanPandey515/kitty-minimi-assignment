import { Router } from "express";
import { randomUUID } from "node:crypto";
import { runAgent, type AgentEvent } from "../agent/index.js";
import { deleteSession, ensureSession, lastTurns, listSessions } from "../db/queries.js";
import { deleteSessionIndex } from "../agent/memory.js";

export const chatRouter = Router();

chatRouter.get("/conversations", (_req, res) => {
  res.json(listSessions());
});

chatRouter.post("/conversations", (_req, res) => {
  const id = randomUUID();
  ensureSession(id);
  res.status(201).json({ id });
});

chatRouter.get("/conversations/:id", (req, res) => {
  res.json(lastTurns(req.params.id, 1000));
});

chatRouter.delete("/conversations/:id", (req, res) => {
  const removed = deleteSession(req.params.id);
  if (!removed) { res.sendStatus(404); return; }
  void deleteSessionIndex(req.params.id).catch((err) => console.warn("[memory] deleted conversation vectors cleanup failed:", (err as Error).message));
  res.sendStatus(204);
});

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
