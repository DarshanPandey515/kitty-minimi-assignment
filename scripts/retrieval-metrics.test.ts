import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreRetrieval } from "./retrieval-metrics.js";

test("no relevant result scores zero", () => {
  assert.deepEqual(scoreRetrieval(["a", "b"], ["x"]), { hitAt8: 0, recallAt3: 0, recallAt5: 0, recallAt8: 0, mrr: 0 });
});

test("relevant result at rank one scores one", () => {
  assert.deepEqual(scoreRetrieval(["x", "a"], ["x"]), { hitAt8: 1, recallAt3: 1, recallAt5: 1, recallAt8: 1, mrr: 1 });
});

test("MRR uses the position in the returned order", () => {
  assert.deepEqual(scoreRetrieval(["a", "b", "x"], ["x"]), { hitAt8: 1, recallAt3: 1, recallAt5: 1, recallAt8: 1, mrr: 1 / 3 });
});

test("Recall@3 and Recall@5 reflect evidence inside each ranking cutoff", () => {
  assert.deepEqual(scoreRetrieval(["n0", "n1", "x", "n3", "y", "n5"], ["x", "y", "z"]), {
    hitAt8: 1, recallAt3: 1 / 3, recallAt5: 2 / 3, recallAt8: 2 / 3, mrr: 1 / 3,
  });
});

test("broad relevance labels separate hit rate from coverage", () => {
  const relevant = Array.from({ length: 40 }, (_, i) => `r${i}`);
  assert.deepEqual(scoreRetrieval(["r17", ...Array.from({ length: 7 }, (_, i) => `n${i}`)], relevant), {
    hitAt8: 1,
    recallAt3: 0.025,
    recallAt5: 0.025,
    recallAt8: 0.025,
    mrr: 1,
  });
});
