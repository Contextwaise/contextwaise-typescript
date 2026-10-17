// Run: npm test. The Contextwaise API is replaced by a stub: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContextwaise, memoryLedger } from "../src/index.ts";

const listing = Array.from({ length: 200 }, (_, i) => `src/feature${i}/components/View${i * 3}.tsx`).concat("src/auth/middleware.ts").join("\n");

test("with an API key: relevance comes from the API, and results + expands are reported in one batch", async (t) => {
  const calls: { url: string; body: any }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body });
    if (url.endsWith("/api/v1/tool-results")) return Response.json({ scores: body.sections.map((s: string) => (s.includes("auth") ? 1 : 0)), scorer: "jev" });
    return Response.json({ ok: true });
  });
  const cw = createContextwaise({ apiKey: "sw_live_test", baseUrl: "http://app.test/", agent: "triage", maxTokens: 60 });
  cw.noteIntent("c1", "Where is the auth middleware?"); // what the AI SDK middleware records
  const r = await cw.shrink({ callId: "c1", tool: "list_files", args: { dir: "." }, output: listing });
  assert.equal(r.scorer, "jev");
  assert.match(r.text, /src\/auth\//);
  await cw.expand(r.ref, "feature 12");
  await cw.flush();

  const score = calls.find((c) => c.url === "http://app.test/api/v1/tool-results")!;
  assert.equal(score.body.agent, "triage");
  const report = calls.find((c) => c.url === "http://app.test/api/v1/tool-results/report")!;
  assert.deepEqual(report.body.results.map((x: any) => x.type), ["result", "expand"]);
  assert.equal(report.body.results[0].tool, "list_files");
  assert.ok(!JSON.stringify(report.body).includes("middleware"), "reports never carry tool output");
});

test("API down: nothing is cut, and the API is not called again for a while", async (t) => {
  let scoreCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/v1/tool-results")) scoreCalls++;
    return new Response("down", { status: 503 });
  });
  const errors: string[] = [];
  const cw = createContextwaise({ apiKey: "k", baseUrl: "http://app.test", maxTokens: 60, onEvent: (e) => e.type === "api_error" && errors.push(e.message) });
  const a = await cw.shrink({ callId: "a", tool: "list_files", args: {}, output: listing });
  const b = await cw.shrink({ callId: "b", tool: "list_files", args: {}, output: listing });
  assert.deepEqual([a.scorer, b.scorer], ["none", "none"]);
  assert.match(a.text, /feature199/, "the whole cleaned output reaches the model");
  assert.equal(scoreCalls, 1, "paused after the first failure");
  assert.ok(errors.length >= 1);
});

test("an API key without an address is a clear error; no key means cleanup only", () => {
  assert.throws(() => createContextwaise({ apiKey: "k" }), /baseUrl/);
  assert.doesNotThrow(() => createContextwaise());
});

test("the in-memory ledger keeps only the most recent calls", async () => {
  const ledger = memoryLedger(3);
  for (const id of ["1", "2", "3", "4"]) await ledger.set(id, { tool: "t", original: id, result: {} as never });
  assert.equal(await ledger.get("1"), undefined);
  assert.equal((await ledger.get("4"))?.original, "4");
});
