import assert from "node:assert/strict";
import { test } from "node:test";

test("RRF merges duplicate candidates and rewards agreement", async () => {
  const { reciprocalRankFusion } = await import("./memory.js");
  const ranked = reciprocalRankFusion([["a", "b"], ["b", "c"]]);
  assert.equal(ranked[0].id, "b");
  assert.equal(ranked.length, 3);
});
