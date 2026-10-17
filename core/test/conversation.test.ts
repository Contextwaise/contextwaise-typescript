// Run: npm test (in core/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationId, recallConversation, rememberConversation, type DecisionStore } from "../src/conversation.ts";
import type { Decision } from "../src/engine.ts";

test("conversation ids: absent is null, safe strings pass, anything else is rejected", () => {
  assert.equal(conversationId(undefined), null);
  assert.equal(conversationId(""), null);
  assert.equal(conversationId("chat_8f2k:turns-1.2"), "chat_8f2k:turns-1.2");
  assert.throws(() => conversationId("has spaces"));
  assert.throws(() => conversationId(42));
  assert.throws(() => conversationId("x".repeat(129)));
});

/** A DecisionStore in memory; `down` makes every call fail like an unreachable Redis. */
function memoryStore() {
  const hashes = new Map<string, Map<string, string>>();
  const store: DecisionStore & { down: boolean } = {
    down: false,
    async readFields(key, fields) {
      return store.down ? null : fields.map((f) => hashes.get(key)?.get(f) ?? null);
    },
    async writeFields(key, entries) {
      if (store.down) return false;
      const h = hashes.get(key) ?? new Map<string, string>();
      for (const [f, v] of Object.entries(entries)) h.set(f, v);
      hashes.set(key, h);
      return true;
    },
  };
  return store;
}

const decision = (id: string, text: string, kept: boolean): Decision => ({ id, text, source: "rag", tokens: 10, score: kept ? 2.5 : 0.4, kept, reason: kept ? "relevant" : "low_relevance" });

test("a conversation recalls each item's decision by its text, whatever id it comes back with", async () => {
  const store = memoryStore();
  await rememberConversation(store, "p", "chat", [decision("a", "refunds take five days", true), decision("b", "office hours", false)], { model: "small" });
  const again = await recallConversation<{ model: string }>(store, "p", "chat", [
    { id: "x", text: "office hours", source: "rag" },
    { id: "y", text: "refunds take five days", source: "rag" },
    { id: "z", text: "something new", source: "rag" },
  ]);
  assert.equal(again.available, true);
  assert.deepEqual(again.route, { model: "small" });
  assert.deepEqual(again.remembered.get("x"), { kept: false, reason: "low_relevance", score: 0.4 });
  assert.deepEqual(again.remembered.get("y"), { kept: true, reason: "relevant", score: 2.5 });
  assert.equal(again.remembered.has("z"), false);
  // Conversations and projects never share decisions.
  assert.equal((await recallConversation(store, "p", "other", [{ id: "y", text: "refunds take five days", source: "rag" }])).remembered.size, 0);
  assert.equal((await recallConversation(store, "q", "chat", [{ id: "y", text: "refunds take five days", source: "rag" }])).remembered.size, 0);
});

test("an unreachable store recalls nothing and says the conversation is unprotected", async () => {
  const store = memoryStore();
  store.down = true;
  const recalled = await recallConversation(store, "p", "chat", [{ id: "a", text: "anything", source: "rag" }]);
  assert.deepEqual([recalled.available, recalled.route, recalled.remembered.size], [false, null, 0]);
  assert.equal(await rememberConversation(store, "p", "chat", [decision("a", "anything", true)]), false);
});
