// Contextwaise demo server: a Vercel AI SDK agent with demo tools, wrapped by
// contextwaise. Every step is streamed to the browser (Server-Sent Events) and
// printed as a log line.
//
//   cd sdk && npm run demo   →   http://localhost:4100
//
// The model (keys in sdk/typescript/.env or the environment; real models are paid):
// - Claude when ANTHROPIC_API_KEY is set (ANTHROPIC_MODEL, default claude-haiku-5-5);
// - otherwise OpenAI when OPENAI_API_KEY is set (OPENAI_MODEL, default gpt-6.1-sol);
// - otherwise a free scripted simulator. DEMO_SIMULATED=1 forces the simulator.
// Relevance: the local engine (free), or your Contextwaise app's API (Jev, paid) when
// CONTEXTWAISE_API_KEY and CONTEXTWAISE_URL are set. With a key, every result is
// also reported to that app's dashboard ("Tool results").

import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, isStepCount, wrapLanguageModel, type LanguageModelMiddleware, type ModelMessage } from "ai";
import { createContextwaise, type ContextwaiseEvent } from "../src/index.ts";
import { withContextwaise } from "../src/ai-sdk.ts";
import { createSimulatedModel } from "./llm.ts";
import { meter, PRICING, type LlmCallEvent } from "./meter.ts";
import { demoTools } from "./tools.ts";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const PORT = Number(process.env.PORT ?? 4100);
const PROVIDER = process.env.DEMO_SIMULATED === "1" ? null : process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : null;
const REAL = PROVIDER !== null;
const MODEL_ID = PROVIDER === "anthropic" ? process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5" : process.env.OPENAI_MODEL ?? "gpt-6.1-sol";
const PRICE = REAL ? PRICING[MODEL_ID] : PRICING.simulated;
if (!PRICE) throw new Error(`No prices for model ${MODEL_ID}; add it to PRICING in demo/meter.ts.`);
const SYSTEM = `You are ShopBot, a senior engineer's assistant for the "shop" monorepo (TypeScript, Node 22, Postgres, Stripe).
Answer precisely and cite file paths and line numbers. Prefer running tools over guessing.
Conventions: features live in src/<feature>/ with service.ts (logic), routes.ts (HTTP), schema.ts (validation) and service.test.ts (Vitest).
Money is stored in cents in the database and shown in euros. Never log card data. Sessions expire after 30 minutes of inactivity.
${"Coding standards: small pure functions, explicit errors, no default exports, tests next to the code. ".repeat(30)}`;

// ---- events: to the browser and the terminal ----

type DemoEvent =
  | LlmCallEvent
  | ContextwaiseEvent
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool.call"; callId: string; tool: string; args: unknown }
  | { type: "tool.output"; callId: string; tool: string; tokens: number; preview: string; full: string }
  | { type: "turn.end"; totals: Totals }
  | { type: "reset" };

type Totals = { calls: number; with: { tokens: number; cacheRead: number; cost: number }; without: { tokens: number; cacheRead: number; cost: number }; toolTokensRaw: number; toolTokensSent: number };
const emptyTotals = (): Totals => ({ calls: 0, with: { tokens: 0, cacheRead: 0, cost: 0 }, without: { tokens: 0, cacheRead: 0, cost: 0 }, toolTokensRaw: 0, toolTokensSent: 0 });

// Everything is also written to sdk/typescript/demo/logs/: demo.log (readable lines) and
// events.jsonl (each event in full, as the page receives it). Ignored by git.
const LOG_DIR = new URL("./logs/", import.meta.url);
mkdirSync(LOG_DIR, { recursive: true });

const clients = new Set<ServerResponse>();
let history: ModelMessage[] = [];
let totals = emptyTotals();
const rawOutputs = new Map<string, string>(); // tool call id -> raw output, for the "without" twin

function send(event: DemoEvent) {
  const stamped = { ...event, at: new Date().toISOString() };
  const json = JSON.stringify(stamped);
  for (const c of clients) c.write(`data: ${json}\n\n`);
  const line = logLine(event);
  console.log(line);
  appendFileSync(new URL("demo.log", LOG_DIR), `${stamped.at} ${line.trimStart()}\n`);
  appendFileSync(new URL("events.jsonl", LOG_DIR), `${json}\n`);
}

const usd = (n: number) => `$${n.toFixed(5)}`;
function logLine(e: DemoEvent): string {
  switch (e.type) {
    case "user": return `\n[user] ${e.text}`;
    case "assistant": return `[assistant] ${e.text.split("\n")[0]}…`;
    case "llm.call": return `[llm #${e.step}] in ${e.with.tokens} tok (cache read ${e.with.cacheRead}, write ${e.with.cacheWrite}) out ${e.with.output} → ${usd(e.with.cost)} | without contextwaise: in ${e.without.tokens} tok → ${usd(e.without.cost)}`;
    case "tool.call": return `[tool] ${e.tool}(${JSON.stringify(e.args)})`;
    case "tool.output": return `[tool] ${e.tool} returned ${e.tokens} tokens`;
    case "shrink": return `[contextwaise] ${e.tool}: ${e.result.mode} ${e.result.kind}, ${e.result.tokensBefore} → ${e.result.tokensAfter} tokens (${e.result.scorer}, ${e.ms}ms)${e.result.notes.length ? " · " + e.result.notes.join("; ") : ""}`;
    case "replay": return `[contextwaise] ${e.tool}: replayed view for ${e.callId} (cache-safe)`;
    case "expand": return `[contextwaise] expand ${e.ref}${e.question ? ` "${e.question}"` : ""} → ${e.tokens} tokens`;
    case "engine_fallback": return `[contextwaise] relevance API failed (${e.error}): passed whole`;
    case "api_error": return `[contextwaise] ${e.message}`;
    case "turn.end": return `[turn] calls ${e.totals.calls} · with ${usd(e.totals.with.cost)} · without ${usd(e.totals.without.cost)}`;
    case "reset": return "[reset]";
  }
}

// ---- the agent ----

// Reads CONTEXTWAISE_API_KEY and CONTEXTWAISE_URL from the environment (sdk/typescript/.env).
const remote = process.env.CONTEXTWAISE_API_KEY ? "api" : "local";
const cw = createContextwaise({
  agent: "shopbot-demo",
  maxTokens: 500,
  // Files up to 1,500 tokens reach the model whole (it may edit them); bigger ones keep
  // the parts relevant to the question, and expand gives back any other part exactly.
  budgets: { read_file: 1500 },
  onEvent: (e) => {
    send(e);
    if (e.type === "shrink") totals.toolTokensSent += e.result.tokensAfter;
  },
});

// Report each tool's raw call and output before contextwaise sees it.
const observed = Object.fromEntries(
  Object.entries(demoTools).map(([name, t]) => [
    name,
    {
      ...t,
      execute: async (args: never, options: { toolCallId: string }) => {
        send({ type: "tool.call", callId: options.toolCallId, tool: name, args });
        const out = await (t.execute as unknown as (a: never, o: unknown) => Promise<unknown>)(args, options);
        const full = typeof out === "string" ? out : JSON.stringify(out, null, 2);
        rawOutputs.set(options.toolCallId, full);
        totals.toolTokensRaw += Math.ceil(full.length / 4);
        send({ type: "tool.output", callId: options.toolCallId, tool: name, tokens: Math.ceil(full.length / 4), preview: full.slice(0, 1200), full: full.slice(0, 60_000) });
        return out;
      },
    },
  ]),
) as unknown as typeof demoTools;

const sim = REAL ? null : createSimulatedModel();
const metering = meter({
  pricing: PRICE,
  rawOutputs,
  simulated: !REAL,
  onCall: (e) => {
    send(e);
    totals.calls++;
    totals.with.tokens += e.with.tokens;
    totals.with.cacheRead += e.with.cacheRead;
    totals.with.cost += e.with.cost;
    totals.without.tokens += e.without.tokens;
    totals.without.cacheRead += e.without.cacheRead;
    totals.without.cost += e.without.cost;
  },
});
// Claude only caches up to an explicit breakpoint (OpenAI caches on its own). One at the
// end of every request: each call writes its whole prompt, and the next call, which
// starts with the same bytes, reads it back. Breakpoints are not part of the cached
// text, so moving it forward never changes the prefix.
const cacheBreakpoint: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const prompt = [...params.prompt];
    const last = prompt[prompt.length - 1];
    prompt[prompt.length - 1] = { ...last, providerOptions: { ...last.providerOptions, anthropic: { ...last.providerOptions?.anthropic, cacheControl: { type: "ephemeral" } } } };
    return { ...params, prompt };
  },
};
const provider = PROVIDER === "anthropic" ? anthropic(PRICE.id) : PROVIDER === "openai" ? openai(PRICE.id) : sim!.model;
// Order matters: the meter sits next to the provider so it sees exactly what is sent.
const metered = wrapLanguageModel({ model: provider, middleware: PROVIDER === "anthropic" ? [cacheBreakpoint, metering] : metering });
const { model, tools } = withContextwaise(cw, { model: metered, tools: observed });

// OpenAI routes requests with the same key to the same prompt cache: one key per
// conversation keeps its shared start cached across turns. Renewed on reset.
let cacheKey = `contextwaise-demo-${Date.now().toString(36)}`;

let busy = false;
async function chat(text: string) {
  send({ type: "user", text });
  history.push({ role: "user", content: text });
  const res = await generateText({ model, tools, system: SYSTEM, messages: history, stopWhen: isStepCount(8), providerOptions: { openai: { promptCacheKey: cacheKey } } });
  // response.messages hold each tool result as the model saw it: resent unchanged on later turns.
  history.push(...res.response.messages);
  send({ type: "assistant", text: res.text });
  send({ type: "turn.end", totals });
}

// ---- HTTP ----

const STATIC: Record<string, [string, string]> = {
  "/": ["public/index.html", "text/html"],
  "/app.js": ["public/app.js", "text/javascript"],
  "/style.css": ["public/style.css", "text/css"],
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    return res.end(await readFile(new URL(file, import.meta.url)));
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "hello", model: PRICE, real: REAL, engine: remote === "local" ? "local" : "remote" })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = String(JSON.parse(body || "{}").message ?? "").trim().slice(0, 2000);
    if (!message) return json(res, 422, { error: "message required" });
    if (busy) return json(res, 409, { error: "the agent is still answering" });
    busy = true;
    try {
      await chat(message);
      return json(res, 200, { ok: true });
    } catch (e) {
      console.error(e);
      return json(res, 500, { error: (e as Error).message });
    } finally {
      busy = false;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/reset") {
    history = [];
    totals = emptyTotals();
    cacheKey = `contextwaise-demo-${Date.now().toString(36)}`;
    rawOutputs.clear();
    sim?.reset();
    metering.reset();
    send({ type: "reset" });
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, () => {
  const line = `Contextwaise demo on http://localhost:${PORT} · LLM: ${PRICE.name}${REAL ? " (real, paid)" : ""} · relevance: ${remote === "local" ? "none, cleanup only (no key)" : "Contextwaise API / Jev (paid)"}`;
  console.log(line);
  appendFileSync(new URL("demo.log", LOG_DIR), `\n${new Date().toISOString()} [start] ${line}\n`);
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
