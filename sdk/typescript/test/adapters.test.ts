// Run: npm test. The Anthropic and OpenAI adapters on hand-written responses; the
// relevance API is a stub (no network): a section is relevant when it has a word of the intent.
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createContextwaise } from "../src/index.ts";
import { expandTool as anthropicExpand, toolResults } from "../src/anthropic.ts";
import { expandTool as chatExpand, expandToolResponses, functionOutputs, toolMessages } from "../src/openai.ts";

const intents: string[] = [];
const reports: { type: string; contextTokens?: number }[] = [];
beforeEach(() => {
  intents.length = 0;
  reports.length = 0;
  mock.restoreAll();
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/tool-results/report")) reports.push(...JSON.parse(init.body as string).results);
    if (!url.endsWith("/api/v1/tool-results")) return Response.json({ stored: 0 });
    const { intent, sections } = JSON.parse(init.body as string) as { intent: string; sections: string[] };
    intents.push(intent);
    const words = intent.toLowerCase().match(/[a-z0-9-]{5,}/g) ?? [];
    return Response.json({ scores: sections.map((s) => (words.some((w) => s.toLowerCase().includes(w)) ? 1 : 0)) });
  });
});
const api = { apiKey: "sw_live_test", baseUrl: "http://app.test", maxTokens: 120 };
const orders = { orders: Array.from({ length: 150 }, (_, i) => ({ id: i === 77 ? "ORD-1337" : `ORD-${1000 + i}`, status: i === 77 ? "lost_in_transit" : "delivered", note: "x".repeat(200) })) };
const run = async (name: string, args: { customer?: string }) => {
  if (name === "get_orders") return orders;
  if (name === "get_weather") return { tempC: 23 };
  throw new Error(`upstream down for ${args.customer ?? name}`);
};

test("expand tools: one definition, three provider formats", () => {
  assert.equal(anthropicExpand.input_schema.required[0], "ref");
  assert.equal(chatExpand.function.name, "expand");
  assert.equal(expandToolResponses.strict, false, "question is optional, so not strict");
});

test("Anthropic: results in order, outputs shrunk, errors marked, intent = request + what the model said", async () => {
  const cw = createContextwaise(api);
  const response = {
    content: [
      { type: "text", text: "Let me check acme's orders and the weather." },
      { type: "tool_use", id: "toolu_1", name: "get_orders", input: { customer: "acme" } },
      { type: "tool_use", id: "toolu_2", name: "get_weather", input: { city: "Lisbon" } },
      { type: "tool_use", id: "toolu_3", name: "get_invoices", input: { customer: "acme" } },
    ],
  };
  const results = await toolResults(cw, response, run, { request: "Where is order ORD-1337?" });
  assert.deepEqual(results.map((r) => r.tool_use_id), ["toolu_1", "toolu_2", "toolu_3"]);
  assert.match(results[0].content, /ORD-1337.*lost_in_transit/);
  assert.ok(results[0].content.length < JSON.stringify(orders).length / 5, "the big result was trimmed");
  assert.equal(results[1].content, JSON.stringify({ tempC: 23 }), "a small result passes whole");
  assert.deepEqual(results[2], { type: "tool_result", tool_use_id: "toolu_3", content: "Error: upstream down for acme", is_error: true });
  assert.ok(intents[0].includes("Where is order ORD-1337?") && intents[0].includes("Let me check acme's orders"));
});

test("Anthropic: expand calls are answered by Contextwaise, not by your tools", async () => {
  const cw = createContextwaise(api);
  const [first] = await toolResults(cw, { content: [{ type: "tool_use", id: "t1", name: "get_orders", input: {} }] }, run, { request: "How many orders are delivered?" });
  const ref = first.content.match(/ref: "(cw_[^"]+)"/)?.[1];
  assert.ok(ref, "the trimmed view carries a ref");
  const usage = { input_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000 };
  const [back] = await toolResults(cw, { content: [{ type: "tool_use", id: "t2", name: "expand", input: { ref, question: "order ORD-1337" } }], usage }, () => assert.fail("expand must not reach your tools"));
  assert.match(back.content, /ORD-1337/);
  await cw.flush();
  assert.equal(reports.find((r) => r.type === "expand")?.contextTokens, 10_050, "the step that asked for it, cached input included");
});

test("Anthropic: no tool calls, nothing to send", async () => {
  assert.deepEqual(await toolResults(createContextwaise(), { content: [{ type: "text", text: "Done." }] }, run), []);
});

test("Chat Completions: tool messages in order, JSON arguments parsed, bad JSON reported", async () => {
  const cw = createContextwaise(api);
  const message = {
    content: "Checking.",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "get_orders", arguments: '{"customer":"acme"}' } },
      { id: "call_2", type: "function", function: { name: "get_weather", arguments: "{not json" } },
    ],
  };
  const out = await toolMessages(cw, message, run, { request: "Status of ORD-1337?" });
  assert.deepEqual(out.map((m) => [m.role, m.tool_call_id]), [["tool", "call_1"], ["tool", "call_2"]]);
  assert.match(out[0].content, /ORD-1337/);
  assert.equal(out[1].content, "Error: the tool arguments were not valid JSON");
});

test("Responses API: function_call_output items, text from earlier message items as intent", async () => {
  const cw = createContextwaise(api);
  const response = {
    output: [
      { type: "reasoning" },
      { type: "message", content: [{ type: "output_text", text: "I'll look up the order." }] },
      { type: "function_call", call_id: "fc_1", name: "get_orders", arguments: '{"customer":"acme"}' },
    ],
  };
  const out = await functionOutputs(cw, response, run, { request: "Where is ORD-1337?" });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "function_call_output");
  assert.equal(out[0].call_id, "fc_1");
  assert.match(out[0].output, /ORD-1337/);
  assert.ok(intents[0].includes("I'll look up the order."));
});

test("replayed views: the same call id gives the same bytes, for every adapter", async () => {
  const cw = createContextwaise(api);
  const response = { content: [{ type: "tool_use", id: "same", name: "get_orders", input: {} }] };
  const a = await toolResults(cw, response, run, { request: "ORD-1337" });
  const b = await toolResults(cw, response, run, { request: "ORD-1337" });
  assert.equal(a[0].content, b[0].content);
});
