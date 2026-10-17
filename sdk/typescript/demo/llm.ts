// A simulated LLM for the demo, so it runs with no API key and no cost.
//
// The "brain" is a script per topic, but it decides only from what it can read in
// the prompt it receives: if a fact it needs was trimmed out of a tool result, it
// calls `expand` to get it back. So the demo shows whether the trimmed view really
// carries what the agent needs.
//
// It reports usage the way Claude's prompt cache would bill it (meter.ts), priced
// like Claude Sonnet 5.5. Used when no OPENAI_API_KEY is set.

import { MockLanguageModelV4 } from "ai/test";
import { PRICING, PromptCache } from "./meter.ts";

type Part = { type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: { type: string; value: unknown } };
type Message = { role: string; content: string | Part[] };

const tokens = (s: string) => Math.ceil(s.length / 4);

/** A scripted model that bills itself like Claude's prompt cache would (meter.ts reads its usage). */
export function createSimulatedModel() {
  let cache = new PromptCache(PRICING.simulated);
  const model = new MockLanguageModelV4({
    modelId: PRICING.simulated.id,
    doGenerate: async ({ prompt, tools }) => {
      const decision = decide(prompt as unknown as Message[]);
      const ids = decision.toolCalls.map((c, i) => ({ ...c, id: `toolu_${Date.now().toString(36)}_${i}` }));
      const outputTokens = tokens(decision.text) + ids.reduce((n, c) => n + tokens(JSON.stringify(c.args)) + 20, 0) + 40;
      const bill = cache.bill(JSON.stringify(tools ?? []) + JSON.stringify(prompt), outputTokens);
      return {
        content: [
          ...(decision.text ? [{ type: "text" as const, text: decision.text }] : []),
          ...ids.map((c) => ({ type: "tool-call" as const, toolCallId: c.id, toolName: c.name, input: JSON.stringify(c.args) })),
        ],
        finishReason: ids.length ? { unified: "tool-calls" as const, raw: "tool_use" } : { unified: "stop" as const, raw: "end_turn" },
        usage: {
          inputTokens: { total: bill.tokens, noCache: bill.cacheWrite, cacheRead: bill.cacheRead, cacheWrite: bill.cacheWrite },
          outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, reset: () => void (cache = new PromptCache(PRICING.simulated)) };
}

// ---- the scripted brain ----

type Decision = { text: string; toolCalls: { name: string; args: Record<string, unknown> }[] };

/** Reads the conversation since the last user message and picks the next move. */
function decide(messages: Message[]): Decision {
  const lastUser = messages.map((m, i) => [m, i] as const).filter(([m]) => m.role === "user").at(-1);
  const question = textOf(lastUser?.[0]).toLowerCase();
  const since = lastUser ? messages.slice(lastUser[1] + 1) : [];
  const results = new Map<string, { text: string; ref?: string }>(); // tool name -> what the model sees
  const called = new Set<string>();
  for (const m of since) {
    if (typeof m.content === "string") continue;
    for (const p of m.content) {
      if (p.type === "tool-call") called.add(p.toolName!);
      if (p.type === "tool-result") {
        const text = String(p.output?.value ?? "");
        results.set(p.toolName!, { text, ref: text.match(/ref: "(cw_\w+)"/)?.[1] });
      }
    }
  }
  const call = (text: string, name: string, args: Record<string, unknown>): Decision => ({ text, toolCalls: [{ name, args }] });
  const answer = (text: string): Decision => ({ text, toolCalls: [] });
  const needOrExpand = (tool: string, pattern: RegExp, question: string): RegExpMatchArray | Decision => {
    const seen = [results.get(tool)?.text, results.get("expand")?.text].join("\n");
    const m = seen.match(pattern);
    if (m) return m;
    const ref = results.get(tool)?.ref;
    if (ref && !called.has("expand")) return call(`I need more detail than the trimmed result shows. Expanding it: ${question}`, "expand", { ref, question });
    return answer("I couldn't find that in the tool output.");
  };

  if (/test|fail/.test(question)) {
    if (!called.has("run_tests")) return call("I'll run the test suite to see what fails.", "run_tests", {});
    const failing = needOrExpand("run_tests", /✗ (\S+) > ([^\n]+)\n\s+(AssertionError[^\n]+)\n\s+❯ \w+ (src\/[\w/.-]+):(\d+)/, "failing test, assertion and source line");
    if (!Array.isArray(failing)) return failing;
    if (!called.has("read_file")) return call(`The first failure is "${failing[2]}" (${failing[3]}), thrown from ${failing[4]}:${failing[5]}. Let me read that file.`, "read_file", { path: failing[4] });
    const bug = results.get("read_file")?.text.match(/\/\/ (BUG: [^\n]+)/)?.[1];
    const second = results.get("run_tests")!.text.match(/✗ \S+ > ([^\n]+)\n\s+(AssertionError[^\n]+)\n\s+❯ \w+ (src\/[\w/.-]+:\d+)/g)?.[1];
    return answer(`Two tests fail.\n\n1. **${failing[2]}**: ${failing[3]}. In ${failing[4]}: ${bug ?? "see line " + failing[5]}. Fix: apply the 10% to \`total\`, not \`cart.subtotal\`.\n2. ${second ? second.split("\n")[0].replace(/^✗ \S+ > /, "**") + "**, " + second.split("\n")[1].trim() : "A session-expiry test also fails."}`);
  }
  if (/auth|middleware|where/.test(question)) {
    if (!called.has("list_files")) return call("Let me find the auth middleware in the repository.", "list_files", { dir: "." });
    // Listings arrive one folder per line: "src/auth/  middleware.ts, session.ts".
    const found = needOrExpand("list_files", /(src\/auth\/)\s+(?:[\w.{}-]+,\s*)*([\w.-]*middleware[\w.-]*)/, "auth middleware file path");
    if (!Array.isArray(found)) return found;
    return answer(`The auth middleware is in \`${found[1]}${found[2]}\`. Next to it, \`src/auth/session.ts\` verifies the session token.`);
  }
  if (/log|error/.test(question)) {
    if (!called.has("search_logs")) return call("I'll check today's logs for errors.", "search_logs", { query: "error" });
    const errors = results.get("search_logs")!.text.match(/ERROR [^\n]+/g) ?? [];
    const cause = needOrExpand("search_logs", /cause: ([^\n]+)/, "root cause of the payment gateway errors");
    if (!Array.isArray(cause)) return cause;
    return answer(`${errors.length} error${errors.length === 1 ? "" : "s"} today, all \`payment-gateway timeout after 30000ms\` (Stripe). Root cause: ${cause[1]}, raised in src/billing/service.ts:88. Everything else is heartbeats and normal requests.`);
  }
  if (/order|acme|customer/.test(question)) {
    if (!called.has("get_orders")) return call("Let me pull Acme's orders.", "get_orders", { customer: "acme" });
    // A total needs every order: if some were trimmed out, get them back first.
    const view = results.get("get_orders")!;
    if (/items? omitted/.test(view.text) && view.ref && !called.has("expand")) {
      return call("Some orders were trimmed from the result and a total needs all of them. Expanding it.", "expand", { ref: view.ref, question: "all acme orders with status and total" });
    }
    const seen = results.get("expand")?.text ?? view.text;
    const totals = [...seen.matchAll(/"total":([\d.]+)/g)].map((m) => Number(m[1]));
    const refunded = (seen.match(/"status":"refunded"/g) ?? []).length;
    return answer(`Acme has ${totals.length} orders this month, ${refunded} refunded, for €${totals.reduce((a, b) => a + b, 0).toFixed(2)} in total.`);
  }
  if (/rate|limit|docs/.test(question)) {
    if (!called.has("fetch_docs")) return call("I'll check the API docs.", "fetch_docs", { url: "https://docs.example.com/api/limits" });
    const rule = needOrExpand("fetch_docs", /Each API key can make[^.]+\.[^.]+\./, "rate limit rule and where to configure it");
    if (!Array.isArray(rule)) return rule;
    return answer(`${rule[0].trim()} When it's exceeded, the API returns 429 with a Retry-After header.`);
  }
  return answer("I can help with this demo repo: try asking why the tests fail, where the auth middleware is, about errors in today's logs, Acme's orders, or the API rate limits.");
}

function textOf(m?: Message): string {
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(" ");
}
