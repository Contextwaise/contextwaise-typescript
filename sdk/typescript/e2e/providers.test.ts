// Live: the Anthropic and OpenAI adapters on real models and a running Contextwaise app.
// Run: npm run test:e2e, with ANTHROPIC_API_KEY, OPENAI_API_KEY, CONTEXTWAISE_API_KEY and
// CONTEXTWAISE_URL set. Each case runs the same loop without Contextwaise as a baseline.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createContextwaise, type Contextwaise } from "../src/index.ts";
import { NEEDLES, orders } from "./fixtures.ts";
import { PROVIDERS, type Run } from "./agents.ts";

const { CONTEXTWAISE_API_KEY: apiKey, CONTEXTWAISE_URL: baseUrl } = process.env;
const STATUS = /lost.?in.?transit/i;
const rows: string[] = [];
after(() => {
  if (rows.length) console.log(`\nInput tokens billed by the model, whole run: without → with Contextwaise\n${rows.join("\n")}`);
});

const record = (name: string, r: Run, base: Run) => {
  const size = (x: Run) => x.results.reduce((n, [, c]) => n + Math.ceil(c.length / 4), 0);
  rows.push(`  ${name.padEnd(32)} ${String(base.inputTokens).padStart(7)} → ${String(r.inputTokens).padStart(6)}  (-${Math.round(100 * (1 - r.inputTokens / base.inputTokens))}%)  tool results ${size(base)} → ${size(r)}`);
};
const connected = (extra: object = {}): Contextwaise => createContextwaise({ apiKey, baseUrl, agent: "ts-e2e", ...extra });

for (const [provider, { key, run }] of Object.entries(PROVIDERS)) {
  describe(provider, { skip: !process.env[key] || !apiKey ? `needs ${key} and CONTEXTWAISE_API_KEY` : false }, () => {
    test("needle in a JSON API response", async () => {
      const q = `Customer acme: what is the status and carrier of order ${NEEDLES.orderId}?`;
      const cw = connected();
      const [r, base] = await Promise.all([run(q, ["get_orders"], cw), run(q, ["get_orders"], null)]);
      await cw.flush();
      assert.match(r.text, STATUS);
      assert.ok(r.text.includes(NEEDLES.orderCarrier), r.text);
      record(`${provider} · orders JSON`, r, base);
    });

    test("error code in 1,600 log lines", async () => {
      const q = "Search today's logs: which error code caused the payment failure?";
      const [r, base] = await Promise.all([run(q, ["search_logs"], connected()), run(q, ["search_logs"], null)]);
      assert.ok(r.text.includes(NEEDLES.errorCode), r.text);
      record(`${provider} · logs`, r, base);
    });

    test("both failing tests out of 320", async () => {
      const q = "Run the test suite and tell me exactly which tests fail.";
      const [r, base] = await Promise.all([run(q, ["run_tests"], connected()), run(q, ["run_tests"], null)]);
      assert.match(r.text, /VIP20/i);
      assert.match(r.text, /idle session|30 minutes/i);
      record(`${provider} · test run`, r, base);
    });

    test("list_files then read_file", async () => {
      const q = "In this repository, find the billing file that defines the late payment fee and tell me its value.";
      const r = await run(q, ["list_files", "read_file"], connected());
      assert.ok(r.toolCalls.includes("list_files") && r.toolCalls.includes("read_file"), String(r.toolCalls));
      assert.ok(r.text.includes(NEEDLES.lateFee), r.text);
    });

    test("tiny budget: the answer survives, through expand if needed", async () => {
      const q = `Customer acme: which carrier handles order ${NEEDLES.orderId}, and what is its total amount?`;
      const r = await run(q, ["get_orders"], connected({ maxTokens: 150 }));
      assert.ok(r.text.includes(NEEDLES.orderCarrier), r.text);
      assert.ok(r.text.includes(String(orders("acme").orders[117].total.amount)), r.text);
    });

    test("a failing tool reaches the model as an error", async () => {
      const r = await run("Show me acme's invoices. If the billing system fails, tell me so and say what error it returned.", ["get_invoices"], connected());
      assert.deepEqual(r.results, [["get_invoices", "Error: billing API unavailable (503)"]]);
      assert.match(r.text, /503|unavailable/i);
    });

    test("wrong Contextwaise key: the agent still answers, nothing cut", async () => {
      const r = await run("Search today's logs: which error code caused the payment failure?", ["search_logs"], connected({ apiKey: "sw_live_wrong_key_000000000000" }));
      assert.ok(r.text.includes(NEEDLES.errorCode), r.text);
      assert.ok(!r.results[0][1].includes("omitted"));
    });

    test("expand brings back a part the view left out", async () => {
      // Turn 2 asks about an order the turn-1 view omitted, with no tool but expand.
      const cw = connected();
      const first = await run(`Customer acme: what is the status of order ${NEEDLES.orderId}?`, ["get_orders"], cw);
      assert.ok(!JSON.stringify(first.results).includes("ORD-1100"), "the view kept only the relevant part");
      const second = await run("From that same orders result, which carrier ships order ORD-1100? Get it from the full output.", [], cw, [...first.history] as never);
      assert.ok(second.toolCalls.includes("expand"), String(second.toolCalls));
      assert.ok(second.text.includes("UPS"), second.text);
    });

    test("follow-up turn resends the earlier view byte for byte", async () => {
      const cw = connected();
      const first = await run(`Customer acme: what is the status of order ${NEEDLES.orderId}?`, ["get_orders"], cw);
      assert.match(first.text, STATUS);
      const before = JSON.stringify(first.history);
      const second = await run("And which carrier was it shipped with?", ["get_orders"], cw, [...first.history] as never);
      assert.ok(second.text.includes(NEEDLES.orderCarrier), second.text);
      assert.equal(JSON.stringify(second.history.slice(0, first.history.length)), before);
    });
  });
}
