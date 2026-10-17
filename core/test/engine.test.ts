// Run: npm test (in core/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCandidate, keepThreshold, normalizeCandidates, select, type Scored } from "../src/engine.ts";

const item = (id: string, text: string, score: number, tokens = 100): Scored => ({ id, text, source: "rag", tokens, score });

test("drops low relevance, duplicates and over-budget items; strongest first", () => {
  const out = select([
    item("a", "refunds take five to seven business days to process", 2.8),
    item("b", "refunds take five to seven business days to process today", 2.5),
    item("c", "office hours are nine to six", 0.3),
    item("d", "invoice was charged twice because of a retry bug", 2.9),
    item("e", "chargeback policy for duplicate payments on cards", 2.0, 900),
  ], 300, keepThreshold("balanced"));
  const byId = Object.fromEntries(out.map((d) => [d.id, d]));
  assert.deepEqual(out.filter((d) => d.kept).map((d) => d.id), ["a", "d"], "kept items stay in the caller's order");
  assert.equal(byId.b.reason, "duplicate");
  assert.equal(byId.b.duplicateOf, "a");
  assert.equal(byId.c.reason, "low_relevance");
  assert.equal(byId.e.reason, "over_budget");
});

test("aggressiveness moves the relevance threshold", () => {
  const items = [item("x", "loosely related background", 1.2)];
  assert.equal(select(items, 1000, keepThreshold("conservative"))[0].kept, true);
  assert.equal(select(items, 1000, keepThreshold("aggressive"))[0].kept, false);
});

test("the learned offset moves the threshold but stays inside the scale", () => {
  assert.equal(keepThreshold("balanced", -0.5), 0.9);
  assert.equal(keepThreshold("aggressive", 5), 2.7);
  assert.equal(keepThreshold("conservative", -5), 0.3);
});

test("new items that duplicate something already sent are dropped; sent items don't use the budget", () => {
  const sent = [{ id: "old", text: "refunds take five to seven business days to process", source: "rag" }];
  const out = select([item("n1", "refunds take five to seven business days to process today", 2.9), item("n2", "chargebacks need a signed form", 2.5)], 100, keepThreshold("balanced"), sent);
  assert.equal(out[0].reason, "duplicate");
  assert.equal(out[0].duplicateOf, "old");
  assert.equal(out[1].kept, true);
});

test("normalizes strings and objects, rejects bad input", () => {
  const c = normalizeCandidates(["  hello  ", { id: "k", text: "world", source: "Web" }, { id: "k", text: "dup id" }]);
  assert.deepEqual(c.map((x) => [x.id, x.text, x.source]), [["c0", "hello", "context"], ["k", "world", "web"], ["k#2", "dup id", "context"]]);
  assert.throws(() => normalizeCandidates([]));
  assert.throws(() => normalizeCandidates([{ text: "  " }]));
});

test("cleanup: structured noise is removed and measured against the size received; plain text is never touched", () => {
  const tests = [...Array.from({ length: 200 }, (_, i) => `  ✓ case ${i} works`), "  ✗ refund rounds wrong", "    AssertionError: expected 81 to be 72", "Tests: 1 failed, 200 passed"].join("\n");
  const c = cleanCandidate({ id: "t", text: tests, source: "tools" });
  assert.ok(c.cleaned?.length && c.text.includes("expected 81 to be 72") && !c.text.includes("case 5 works"));
  assert.ok(c.originalTokens! > c.text.length / 4 * 5, "savings measured against the original");
  const rag = { id: "r", text: "Refunds take five to seven business days to process.", source: "rag" };
  assert.deepEqual(cleanCandidate(rag), { ...rag, originalTokens: 13 });
});
