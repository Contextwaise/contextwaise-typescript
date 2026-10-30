// Run: npm test (from sdk/). No network: the relevance API is a stub, the model is the AI SDK's mock.
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { generateText, isStepCount, jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createContextwaise } from "../src/index.ts";
import { withContextwaise } from "../src/ai-sdk.ts";
import { shape, tokens } from "@contextwaise/core";

// The relevance API stub: a section is relevant when it contains one of the intent's
// distinctive words (4+ letters). Groups of lines are scored as one, like the real API.
beforeEach(() => {
  mock.restoreAll();
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (!url.endsWith("/api/v1/tool-results")) return Response.json({ stored: 0 });
    const { intent, sections } = JSON.parse(init.body as string) as { intent: string; sections: string[] };
    // Like the real API (LIMITS.sectionChars): one oversized section rejects the whole call.
    if (sections.some((s) => s.length > 20_000)) return Response.json({ error: { code: "invalid_request" } }, { status: 422 });
    const needles = (intent.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !GENERIC.has(w));
    return Response.json({ scores: sections.map((s) => (needles.some((n) => s.toLowerCase().includes(n)) ? 1 : 0)) });
  });
});
const GENERIC = new Set(["list", "files", "find", "where", "read", "file"]);
const api = { apiKey: "sw_live_test", baseUrl: "http://app.test" };

const testRun = [
  ...Array.from({ length: 300 }, (_, i) => `  ✓ module ${i} works (${i % 9}ms)`),
  "  ✗ checkout applies discount",
  "    AssertionError: expected 90 to equal 81 at src/checkout.ts:42",
  "Tests: 1 failed, 300 passed",
].join("\n");

test("shapers: passing tests, repeated log lines, empty JSON fields and HTML noise go; errors stay", () => {
  const t = shape(testRun);
  assert.equal(t.kind, "test");
  assert.ok(!t.text.includes("module 5 works") && t.text.includes("expected 90 to equal 81"));
  const log = shape(Array.from({ length: 50 }, (_, i) => `2026-10-01 10:00:${String(i).padStart(2, "0")} INFO heartbeat ok`).join("\n"));
  assert.match(log.text, /heartbeat ok  \(×50\)$/);
  assert.equal(shape('{"id":1,"note":null,"tags":[]}').text, '{"id":1}');
  assert.doesNotMatch(shape("<html><body><nav>Menu</nav><p>Rate limit: 100/min</p><script>x()</script></body></html>").text, /Menu|x\(\)/);
});

test("shrink: trims to the parts matching the intent, keeps errors, and replays the same view by call id", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 120 });
  const listing = Array.from({ length: 200 }, (_, i) => `src/feature${i}/index.ts`).concat("src/auth/middleware.ts").join("\n");
  cw.noteIntent("call_1", "Let me find the auth middleware.");
  const r = await cw.shrink({ callId: "call_1", tool: "list_files", args: { dir: "." }, output: listing });
  assert.equal(r.mode, "trimmed");
  assert.match(r.text, /src\/auth\/\s+middleware\.ts/);
  assert.ok(r.tokensAfter < r.tokensBefore / 5);
  const again = await cw.shrink({ callId: "call_1", tool: "list_files", args: { dir: "." }, output: "anything" });
  assert.equal(again.text, r.text, "same call id → byte-identical view");
  assert.match(await cw.expand(r.ref, "feature42"), /src\/feature42\/\s+index\.ts/);
});

test("API envelopes: each item of { meta, orders: [...] } is its own part, and no section exceeds the API limit", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 300 });
  const orders = Array.from({ length: 180 }, (_, i) => ({ id: i === 117 ? "ORD-1337" : `ORD-${1000 + i}`, status: i === 117 ? "lost_in_transit" : "delivered", note: "x".repeat(300) }));
  cw.noteIntent("call_env", "What is the status of ORD-1337?");
  const r = await cw.shrink({ callId: "call_env", tool: "get_orders", args: {}, output: { page: 1, orders } });
  assert.equal(r.mode, "trimmed");
  assert.match(r.text, /"orders\[117\]":\{"id":"ORD-1337","status":"lost_in_transit"/);
  assert.ok(r.tokensAfter < r.tokensBefore / 5);
});

test("ids the intent asks about reach the scorer unmasked (other long numbers are masked)", async () => {
  const sent: string[] = [];
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const { sections } = JSON.parse(init.body as string) as { sections: string[] };
    sent.push(...sections);
    return Response.json({ scores: sections.map((s) => (s.includes("1337") ? 1 : 0)) });
  });
  const cw = createContextwaise({ ...api, maxTokens: 200 });
  const rows = Array.from({ length: 300 }, (_, i) => `order ORD-${1000 + i * 2 + 1} shipped by carrier ${i % 3}, reference 2026${i}`).join("\n");
  cw.noteIntent("call_id", "Where is order ORD-1337?");
  const r = await cw.shrink({ callId: "call_id", tool: "search", args: {}, output: rows });
  assert.ok(sent.some((s) => s.includes("ORD-1337")), "the asked id is sent as is");
  assert.ok(!sent.some((s) => s.includes("ORD-1339")), "other ids are still masked");
  assert.match(r.text, /ORD-1337/);
});

test("shrink: small outputs and `full` tools pass untouched", async () => {
  const cw = createContextwaise({ full: ["read_file"] });
  assert.equal((await cw.shrink({ callId: "a", tool: "get_time", args: {}, output: "10:42" })).text, "10:42");
  const big = "line\n".repeat(5000);
  assert.equal((await cw.shrink({ callId: "b", tool: "read_file", args: { path: "x" }, output: big })).text, big);
});

test("AI SDK: the model reads the short view, the app keeps the raw output, intent comes from the model's text", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 150 });
  const prompts: string[] = [];
  let step = 0;
  const base = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
      if (step++ === 0) {
        return {
          content: [{ type: "text", text: "Let me run the tests to see what fails." }, { type: "tool-call", toolCallId: "t1", toolName: "run_tests", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: "text", text: "The checkout discount test fails." }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] };
    },
  });
  const run_tests = tool({ description: "Run the test suite", inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: async () => testRun });
  const { model, tools } = withContextwaise(cw, { model: base, tools: { run_tests } });

  const res = await generateText({ model, tools, prompt: "Why do the tests fail?", stopWhen: isStepCount(3) });

  assert.equal(res.text, "The checkout discount test fails.");
  assert.ok(prompts[1].includes("expected 90 to equal 81"), "the failure reaches the model");
  assert.ok(!prompts[1].includes("module 150 works"), "passing tests don't");
  assert.ok(prompts[1].length < testRun.length / 4);
  assert.equal(res.steps[0].toolResults[0].output, testRun, "the app keeps the raw output");
  assert.ok("expand" in tools);
});

test("AI SDK: an expand reports the size of the step that asked for it, as the model read it", async () => {
  const reports: { type: string; contextTokens?: number }[] = [];
  const stub = globalThis.fetch;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/tool-results/report")) reports.push(...JSON.parse(init.body as string).results);
    return stub(url, init);
  });
  const cw = createContextwaise({ ...api, maxTokens: 150 });
  let step = 0;
  let expandPrompt = "";
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
  const base = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const finish = { unified: "tool-calls", raw: "tool_use" } as const;
      if (step++ === 0) return { content: [{ type: "tool-call", toolCallId: "t1", toolName: "get_orders", input: "{}" }], finishReason: finish, usage, warnings: [] };
      if (step === 2) {
        expandPrompt = JSON.stringify(prompt);
        const ref = expandPrompt.match(/cw_[0-9a-z]+/)![0];
        return { content: [{ type: "tool-call", toolCallId: "x1", toolName: "expand", input: JSON.stringify({ ref, question: "carrier of ORD-1337" }) }], finishReason: finish, usage, warnings: [] };
      }
      return { content: [{ type: "text", text: "Done." }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] };
    },
  });
  const orders = Array.from({ length: 150 }, (_, i) => ({ id: i === 77 ? "ORD-1337" : `ORD-${1000 + i}`, status: i === 77 ? "lost_in_transit" : "delivered", note: "x".repeat(200) }));
  const get_orders = tool({ description: "List orders", inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: async () => orders });
  const { model, tools } = withContextwaise(cw, { model: base, tools: { get_orders } });

  await generateText({ model, tools, prompt: "Where is ORD-1337?", stopWhen: isStepCount(4) });
  await cw.flush();

  const [expand] = reports.filter((r) => r.type === "expand");
  // The prompt's text, without the JSON syntax (escaped quotes) that would over-size it.
  assert.ok(expand.contextTokens! > tokens(expandPrompt) / 2 && expand.contextTokens! < tokens(expandPrompt), "the prompt of the step that called expand");
  assert.ok(expand.contextTokens! < tokens(JSON.stringify(orders)) / 4, "views, not raw outputs");
});

test("when every part is equally relevant, the cleaned output is kept whole instead of cut arbitrarily", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 200 });
  const orders = Array.from({ length: 20 }, (_, i) => ({ id: `ord_${i}`, customer: "acme", total: 10 + i, note: null, tags: [] }));
  const r = await cw.shrink({ callId: "o1", tool: "get_orders", args: { customer: "acme" }, output: orders });
  assert.equal(r.mode, "shaped");
  assert.equal((r.text.match(/"id":"ord_/g) ?? []).length, 20, "no order dropped");
  assert.ok(!r.text.includes("null"), "empty fields still removed");
});

test("a view that only lost noise doesn't invite expand (a careful model would waste a round trip)", async () => {
  const cw = createContextwaise();
  const r = await cw.shrink({ callId: "t9", tool: "run_tests", args: {}, output: testRun });
  assert.equal(r.mode, "shaped");
  assert.doesNotMatch(r.text, /expand/);
  assert.match(r.text, /Everything else is shown in full/);
});

test("inside a group the API judged relevant, the lines matching the intent come first", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 120 });
  const listing = ["src/admin/index.ts", ...Array.from({ length: 300 }, (_, i) => `src/feature${i}/service.ts`), "src/auth/middleware.ts", "src/auth/session.ts"].join("\n");
  cw.noteIntent("l1", "Where is the auth middleware? "); // what the middleware records when the model says nothing
  const r = await cw.shrink({ callId: "l1", tool: "list_files", args: { dir: "src" }, output: listing });
  assert.match(r.text, /src\/auth\/\s+middleware\.ts/);
});

test("per-tool budgets: small files pass whole, big ones keep the relevant parts", async () => {
  const cw = createContextwaise({ ...api, budgets: { read_file: 1500 } });
  const small = "export const a = 1;\n".repeat(100);
  assert.equal((await cw.shrink({ callId: "f1", tool: "read_file", args: { path: "a.ts" }, output: small })).text, small);
  const big = Array.from({ length: 3000 }, (_, i) => `export const value${i} = compute(${i});`).join("\n\n");
  assert.equal((await cw.shrink({ callId: "f2", tool: "read_file", args: { path: "b.ts" }, output: big })).mode, "trimmed");
});

test("listings: one line per folder, numbered series collapsed, nothing lost", () => {
  const paths = [...Array.from({ length: 30 }, (_, i) => `src/admin/components/Widget${i}.tsx`), "src/admin/index.ts", "src/auth/middleware.ts", "src/auth/session.ts", "README.md", "a/b/x1.ts", "a/b/x5.ts"];
  const r = shape(paths.concat(Array.from({ length: 20 }, (_, i) => `src/f${i}/index.ts`)).join("\n"));
  assert.equal(r.kind, "listing");
  assert.match(r.text, /^src\/admin\/components\/  Widget\{0\.\.29\}\.tsx$/m);
  assert.match(r.text, /^src\/auth\/  middleware\.ts, session\.ts$/m);
  assert.match(r.text, /^a\/b\/  x1\.ts, x5\.ts$/m, "non-contiguous numbers stay listed");
});

test("a view is never bigger than the original", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 50 });
  const text = Array.from({ length: 40 }, (_, i) => `value ${i} is computed here`).join("\n\n");
  const r = await cw.shrink({ callId: "n1", tool: "read_file", args: { path: "x.ts" }, output: text });
  assert.ok(r.tokensAfter <= r.tokensBefore);
});

test("shapers: Windows line endings keep their content, zero-padded series keep their padding", () => {
  const crlf = shape("first line\r\nsecond line\r\n");
  assert.equal(crlf.text, "first line\nsecond line");
  assert.deepEqual(crlf.notes, []);
  const paths = [1, 2, 3, 4, 5].map((i) => `img/frame00${i}.png`).concat("img/frame010.png", ...Array.from({ length: 20 }, (_, i) => `x/y${i}/a.ts`));
  const { text } = shape(paths.join("\n"));
  assert.match(text, /frame00\{1\.\.5\}\.png/);
  assert.match(text, /frame010\.png/);
});

test("shapers: HTML keeps the title on its own line and drops cookie banners and asides", () => {
  const page = `<html><head><title>Filtering at scale</title></head><body><div class="cookie-banner">We use cookies. Accept all</div><article><p>Qdrant filters during search.</p></article><aside>Subscribe to our newsletter</aside></body></html>`;
  const { text } = shape(page);
  assert.equal(text, "Filtering at scale\nQdrant filters during search.");
});

test("without the API, nothing is cut: the model reads the cleaned output whole", async () => {
  mock.method(globalThis, "fetch", async () => new Response("down", { status: 503 }));
  const listing = Array.from({ length: 200 }, (_, i) => `src/feature${i}/index.ts`).join("\n");
  for (const cw of [createContextwaise({ maxTokens: 60 }), createContextwaise({ ...api, maxTokens: 60 })]) {
    const r = await cw.shrink({ callId: "w1", tool: "list_files", args: { dir: "." }, output: listing });
    assert.notEqual(r.mode, "trimmed");
    assert.equal(r.scorer, "none");
    assert.match(r.text, /feature199/);
  }
});

test("JSON outputs are measured compact, as providers send them; only real whitespace earns the compaction note", async () => {
  const output = { orders: [{ id: "a", total: 1 }, { id: "b", total: 2 }] };
  const r = await createContextwaise().shrink({ callId: "j1", tool: "get_orders", args: {}, output });
  assert.equal(r.tokensBefore, tokens(JSON.stringify(output)));
  assert.ok(!shape(JSON.stringify(output)).notes.includes("compacted JSON whitespace"));
  assert.ok(shape(JSON.stringify(output, null, 2)).notes.includes("compacted JSON whitespace"));
});

test("line-oriented text (schema dumps, query results) is cut by line, not dropped whole as one part", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 200 });
  const schema = [
    ...Array.from({ length: 70 }, (_, i) => `TABLE app_events_${i} (id text, kind text, value jsonb, created_at timestamptz)`),
    "TABLE billing_refunds (id text, charge_id text, amount_cents int, reason text)",
    ...Array.from({ length: 30 }, (_, i) => `TABLE ops_stats_${i} (id text, metric text, value int)`),
  ].join("\n");
  cw.noteIntent("call_schema", "Which table holds refunds? Let me look at the schema.");
  const r = await cw.shrink({ callId: "call_schema", tool: "describe_schema", args: {}, output: schema });
  assert.equal(r.mode, "trimmed");
  assert.equal(r.kind, "lines");
  assert.match(r.text, /TABLE billing_refunds \(id text/);
  assert.match(r.text, /… lines \d+-\d+ omitted/);
  assert.ok(!r.text.split("\n[contextwaise:")[0].includes("\n\n"), "rows stay one per line");
  assert.ok(r.tokensAfter < r.tokensBefore / 5);
  assert.match(await cw.expand(r.ref, "ops_stats_7"), /TABLE ops_stats_7 \(/);
});

test("shapers: tables are line-oriented and keep every row (a CSV starting with dates is not a log); code is text", () => {
  const csv = ["date,users,calls", ...Array.from({ length: 28 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")},${(i + 1) * 3},${(i + 1) * 100}`)].join("\n");
  assert.equal(shape(csv).kind, "lines");
  assert.equal(shape(csv).text, csv, "rows are kept as they are: no collapsing of near-identical lines");
  const code = Array.from({ length: 12 }, (_, i) => `def f${i}(x):\n    y = x + ${i}\n    return y * 2`).join("\n\n");
  assert.equal(shape(code).kind, "text");
});

test("a cut that saves too little is not made, and costs no scoring", async () => {
  const scored: string[] = [];
  const stub = globalThis.fetch;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/v1/tool-results")) scored.push(url);
    return stub(url, init);
  });
  // About 1,300 tokens over a 600 budget: cutting would save ~700, less than one expand can cost.
  const medium = Array.from({ length: 220 }, (_, i) => `src/feature${i}/index.ts`).join("\n");
  const cw = createContextwaise({ ...api, maxTokens: 600 });
  cw.noteIntent("m1", "Let me find feature 7.");
  const r = await cw.shrink({ callId: "m1", tool: "list_files", args: {}, output: medium });
  assert.notEqual(r.mode, "trimmed");
  assert.doesNotMatch(r.text, /expand/);
  assert.deepEqual(scored, [], "the API isn't asked when no cut would be worth it");
});

test("the note says which items were cut and counts their values", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 120 });
  const orders = Array.from({ length: 150 }, (_, i) => ({ id: i === 77 ? "ORD-1337" : `ORD-${1000 + i}`, status: i === 77 ? "lost_in_transit" : "delivered", carrier: i === 77 ? "Hermes" : i % 2 ? "DHL" : "UPS", note: "x".repeat(200) }));
  cw.noteIntent("o1", "Where is order ORD-1337?");
  const r = await cw.shrink({ callId: "o1", tool: "get_orders", args: {}, output: orders });
  assert.equal(r.mode, "trimmed");
  assert.match(r.text, /ORD-1337/);
  assert.match(r.text, /… items 1-77 omitted/);
  assert.match(r.text, /Omitted: 149 items; status: delivered ×149; carrier: (DHL ×75, UPS ×74|UPS ×75, DHL ×74)\./);
});

// An MCP server describing one action: a long description and a large input schema, as a
// Notion MCP returns for `notion-query-data-sources` called without params.
const actionSchema = {
  server: "notion",
  action: "notion-query-data-sources",
  description: "Query Notion data sources using faithful structured rows, SQL, or a saved view. ".repeat(40),
  input_schema: {
    jsonSchema: {
      type: "object",
      required: ["data_source_urls", "mode"],
      properties: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`param_${i}`, { type: "string", description: `Parameter ${i} of the query: ${"how rows are filtered and paged. ".repeat(12)}` }]),
      ),
    },
  },
};

// The same text as data rather than a schema (no `type: "object"` + `properties`): cut like any result.
const queryRows = { description: actionSchema.description, rows: actionSchema.input_schema.jsonSchema.properties };

test("sections: a big JSON value is cut into path-named parts, so one property can be kept", async () => {
  const { sections } = await import("@contextwaise/core");
  const units = sections("json", JSON.stringify(actionSchema));
  assert.ok(units.some((u) => u.startsWith('{"input_schema.jsonSchema.properties.param_7":')), "each schema property is its own part");
  assert.ok(units.every((u) => tokens(u) <= 1000 || u.startsWith('{"description"')), "only an unsplittable string stays large");
});

test("expand: asked again about the same result, it returns parts not shown yet, then says so", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 300 });
  const view = await cw.shrink({ callId: "c-schema", tool: "mcp_notion", args: { action: "notion-query-data-sources" }, output: queryRows });
  assert.equal(view.mode, "trimmed");
  const question = "Show the input schema parameter list with how rows are filtered";
  const answers: string[] = [];
  for (let i = 0; i < 12; i++) answers.push(await cw.expand(view.ref, question));
  const parts = (a: string) => a.split("\n").filter((l) => l.startsWith("{"));
  assert.ok(parts(answers[0]).length > 0 && parts(answers[1]).length > 0);
  assert.equal(parts(answers[0]).filter((p) => parts(answers[1]).includes(p)).length, 0, "the second answer repeats nothing");
  assert.match(answers.at(-1)!, /already shown above/, "once every relevant part was sent, it says so instead of resending");
});

test("Vercel AI SDK: a call marked full reaches the model whole", async () => {
  const cw = createContextwaise(api);
  const mcp = tool({ inputSchema: jsonSchema<{ action?: string; params?: object }>({ type: "object" }), execute: async () => actionSchema });
  const { tools } = withContextwaise(cw, { model: new MockLanguageModelV4(), tools: { mcp_notion: mcp }, full: (_tool, args) => (args as { params?: object }).params === undefined });
  const describe = await tools.mcp_notion.toModelOutput!({ toolCallId: "d1", input: { action: "notion-query-data-sources" }, output: actionSchema });
  assert.equal((describe as { value: string }).value, JSON.stringify(actionSchema), "describing an action: whole");
  const run = await tools.mcp_notion.toModelOutput!({ toolCallId: "d2", input: { action: "notion-query-data-sources", params: { mode: "sql" } }, output: queryRows });
  assert.ok((run as { value: string }).value.length < JSON.stringify(queryRows).length, "running it: shrunk as usual");
});

// A Notion MCP `notion-fetch` of one database, as the MCP client returns it: the data is one
// JSON string inside the MCP envelope. Measured: ~2.2K tokens, cut to a 64-token empty view,
// expanded at once in a 21K-token conversation.
const notionFetch = {
  content: [{
    type: "text",
    text: JSON.stringify({
      metadata: { type: "database" },
      title: "Gitmore",
      url: "https://app.notion.com/p/2a1476bfc2af80cf962cea6e66fef4c0",
      text: Array.from({ length: 60 }, (_, i) => `<property name="Field ${i}" type="select">option ${i} for the Gitmore roadmap board</property>`).join("\n"),
    }),
  }],
};

test("shapers: an MCP result is unwrapped, and the JSON string inside is cut like JSON", async () => {
  const { sections } = await import("@contextwaise/core");
  const shaped = shape(JSON.stringify(notionFetch));
  assert.equal(shaped.kind, "json");
  assert.ok(shaped.notes.includes("unwrapped the MCP result"));
  const units = sections(shaped.kind, shaped.text);
  assert.ok(units.length > 3 && units.every((u) => tokens(u) <= 600), "the long text field is cut into chunks");
  assert.equal(shape(JSON.stringify({ content: [{ type: "text", text: "boom" }], isError: true })).text, "Error: boom");
});

test("a cut must save more in a long conversation: there, a wrong cut costs an expand resending it all", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 300 });
  const args = { action: "notion-fetch", params: { id: "Gitmore" } };
  cw.noteIntent("short", "Fetch the Gitmore roadmap", { contextTokens: 2_000 });
  cw.noteIntent("long", "Fetch the Gitmore roadmap", { contextTokens: 60_000 });
  const inShort = await cw.shrink({ callId: "short", tool: "mcp_notion", args, output: notionFetch });
  const inLong = await cw.shrink({ callId: "long", tool: "mcp_notion", args, output: notionFetch });
  assert.equal(inShort.mode, "trimmed", "a 2K-token conversation: cutting ~2K tokens pays");
  assert.notEqual(inLong.mode, "trimmed", "a 60K-token conversation: the same cut would not pay for one expand");
});

test("a view that would keep nothing is not sent: the output is", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 200 });
  const blob = "zzzz ".repeat(4000); // one paragraph, unrelated to the intent, far over budget
  const view = await cw.shrink({ callId: "blob", tool: "dump", args: { q: "invoices" }, output: blob });
  assert.notEqual(view.mode, "trimmed");
  assert.ok(view.tokensAfter >= tokens(blob.trim()) - 1);
});

test("any tool output reaches the model: nothing a tool returns can break the step", async () => {
  const cw = createContextwaise(api);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const [i, output] of [undefined, circular, { n: 10n }].entries()) {
    const view = await cw.shrink({ callId: `odd${i}`, tool: "t", args: {}, output });
    assert.equal(view.mode, "full");
  }
});

const ordersOf = (n: number, extra: (i: number) => object = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ id: `ORD-${1000 + i}`, customer: `Customer ${i}`, items: Array.from({ length: 4 }, (_, j) => ({ sku: `SKU-${i}-${j}`, name: `Product ${j} with a long name` })), ...extra(i) }));

test("data in a format that isn't plain JSON is still cut to the relevant part", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 300 });
  const json = JSON.stringify({ orders: ordersOf(80) });
  const outputs = {
    fenced: "```json\n" + json + "\n```",
    prefixed: "Found 80 orders:\n" + json,
    oneLine: ordersOf(300).map((o) => `${o.id} for ${o.customer}.`).join(" "),
    xmlOneLine: `<orders>${ordersOf(200).map((o) => `<order id="${o.id}"><c>${o.customer}</c></order>`).join("")}</orders>`,
  };
  for (const [name, output] of Object.entries(outputs)) {
    const view = await cw.shrink({ callId: name, tool: "lookup", args: { id: "ORD-1042" }, output });
    assert.equal(view.mode, "trimmed", name);
    assert.match(view.text, /ORD-1042/, name);
  }
});

test("JSON items mentioning a failure are data, not errors: they don't crowd out the relevant item", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 300 });
  const output = ordersOf(80, (i) => ({ payment: i % 2 ? "failed" : "ok" }));
  const view = await cw.shrink({ callId: "pay", tool: "lookup", args: { id: "ORD-1042" }, output });
  assert.equal(view.mode, "trimmed");
  assert.match(view.text, /ORD-1042/);
});

test("records in a list are judged whole: the one relevant order is kept with its notes, not split into fields", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 600 });
  // Raw API records (~800 tokens each), as a Notion query returns pages.
  const page = (i: number, note: string) => ({
    object: "page", id: `id-${i}`, created_time: "2026-01-01", archived: false, in_trash: false, url: `https://notion.so/ORD-${2000 + i}`,
    properties: { "Order ID": { title: [{ plain_text: `ORD-${2000 + i}`, annotations: { bold: false, italic: false, color: "default" } }] }, Notes: { rich_text: [{ plain_text: note, annotations: { bold: false, italic: false, color: "default" } }] }, padding: "p".repeat(2600) },
  });
  const pages = Array.from({ length: 60 }, (_, i) => page(i, i === 41 ? "Delivered damaged: clamp cracked, replacement shipped" : "Customer confirmed reception by email"));
  const view = await cw.shrink({ callId: "records", tool: "query", args: { q: "which order was damaged" }, output: { data: { results: pages } } });
  assert.equal(view.mode, "trimmed");
  assert.match(view.text, /ORD-2041[\s\S]*Delivered damaged/, "the record with its notes, whole");
  assert.equal(view.sections.filter((s) => s.kept).length, 1);
});

test("schemas and lists of actions pass whole without being marked, even in an MCP envelope; data with a `properties` field is still cut", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 200 });
  const actions = Array.from({ length: 60 }, (_, i) => ({ name: `notion-action-${i}`, description: `Does thing ${i} in the workspace, with options`, inputSchema: { type: "object", properties: { query: { type: "string", description: `query for ${i}` }, limit: { type: "number" } }, required: ["query"] } }));
  const mcp = { content: [{ type: "text", text: JSON.stringify({ tools: actions }) }] };
  const r = await cw.shrink({ callId: "schema", tool: "mcp_notion", args: {}, output: mcp });
  assert.deepEqual([r.mode, r.reason], ["full", "schema"]);
  assert.match(r.text, /notion-action-59/);

  const d = await cw.shrink({ callId: "pages", tool: "mcp_notion", args: { query: "gitmore" }, output: notionPages });
  assert.deepEqual([d.mode, d.reason], ["trimmed", "cut"]);
});
const notionPages = Array.from({ length: 80 }, (_, i) => ({ id: `page-${i}`, properties: { title: i === 42 ? "Gitmore roadmap" : `Meeting notes ${i}`, status: "Done" } }));

test("every result says why it got its view", async () => {
  const cw = createContextwaise({ ...api, maxTokens: 200, full: ["read_file"] });
  const reasons = await Promise.all([
    cw.shrink({ callId: "r1", tool: "read_file", args: {}, output: testRun }),
    cw.shrink({ callId: "r2", tool: "echo", args: {}, output: "ok" }),
    cw.shrink({ callId: "r3", tool: "mcp_notion", args: { query: "gitmore" }, output: notionPages }),
  ]).then((rs) => rs.map((r) => r.reason));
  assert.deepEqual(reasons, ["marked_full", "fits_budget", "cut"]);
  const offline = await createContextwaise({ maxTokens: 200 }).shrink({ callId: "r4", tool: "mcp_notion", args: { query: "gitmore" }, output: notionPages });
  assert.equal(offline.reason, "api_unavailable");
});
