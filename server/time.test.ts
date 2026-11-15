import test from "node:test";
import assert from "node:assert/strict";
import { resolveRelative } from "./time.js";

const now = new Date("2025-11-15T10:00:00Z"); // Saturday
const day = (r: [string, string] | null) => r && r[0].slice(0, 10) + ".." + r[1].slice(0, 10);

test("yesterday", () => assert.equal(day(resolveRelative("what about yesterday", now)), "2025-11-14..2025-11-14"));
test("last Tuesday", () => assert.equal(day(resolveRelative("Last Tuesday I asked", now)), "2025-11-11..2025-11-11"));
test("on Monday", () => assert.equal(day(resolveRelative("On Monday we shortlisted", now)), "2025-11-10..2025-11-10"));
test("3 November", () => assert.equal(day(resolveRelative("What did I ask on 3 November? still correct today?", now)), "2025-11-03..2025-11-03"));
test("November 3rd", () => assert.equal(day(resolveRelative("on November 3rd", now)), "2025-11-03..2025-11-03"));
test("future month rolls to previous year", () => assert.equal(day(resolveRelative("on 3 December", now)), "2024-12-03..2024-12-03"));
test("last week", () => assert.equal(day(resolveRelative("last week", now)), "2025-11-03..2025-11-09"));
test("today", () => assert.equal(day(resolveRelative("today", now)), "2025-11-15..2025-11-15"));
test("none", () => assert.equal(resolveRelative("hello there", now), null));
test("end is inclusive end-of-day", () => assert.equal(resolveRelative("today", now)![1], "2025-11-15T23:59:59.999Z"));
