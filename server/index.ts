import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chatRouter } from "./routes/chat.js";
import { startMemoryIndexWorker, warmupMemoryModel } from "./agent/memory.js";
import { startClaimExtractionWorker } from "./agent/extractor.js";

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use("/api", chatRouter);

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`server on http://localhost:${port}`);
  console.info("[memory] First run downloads ~25 MB, subsequent runs load from cache.");
  void warmupMemoryModel().catch((err) => console.warn("[memory] MiniLM warm-up failed; SQL retrieval remains available:", (err as Error).message));
  startMemoryIndexWorker();
  startClaimExtractionWorker();
});
