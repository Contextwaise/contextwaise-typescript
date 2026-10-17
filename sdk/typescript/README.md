# contextwaise

Shrinks agent **tool results** before the model reads them: cache-safe, reversible, intent-aware.

In an agent loop, every tool result is resent on every later turn. A 20K-token test log read at turn 3 of a 20-turn task is paid ~17 more times. Contextwaise gives the model a short view of each result, once, at the moment the tool returns:

1. **Shapers** (free, local, deterministic): strip color codes and progress bars, drop passing tests, collapse repeated log lines, remove empty JSON fields, turn HTML into text. Errors are never removed.
2. **Size gate**: results that fit the budget pass as they are.
3. **Relevance**: the parts that match what the agent was doing (the text it wrote before the call, plus the call's arguments) are kept within the budget; everything else becomes `… N lines omitted`.
4. **Nothing is lost**: the model can call `expand({ ref, question })` to get any part back.

Cache-safe by design: a result's view is decided once and replayed byte-for-byte by tool call id, so the provider's prompt cache keeps hitting and edited-history checks (newer Claude models) never trip.

## Vercel AI SDK

```ts
import { generateText, isStepCount } from "ai";
import { openai } from "@ai-sdk/openai";
import { createContextwaise } from "contextwaise";
import { withContextwaise } from "contextwaise/ai-sdk";

const cw = createContextwaise({ agent: "support-triage", budgets: { read_file: 1500 } }); // + CONTEXTWAISE_API_KEY / CONTEXTWAISE_URL
const { model, tools } = withContextwaise(cw, { model: openai("gpt-6.1-sol"), tools: myTools });

const { text } = await generateText({ model, tools, prompt, stopWhen: isStepCount(10) });
```

- Tools keep returning their full output to your app (`steps[].toolResults`, UI stream). Only the model's view changes, via the AI SDK's own `toModelOutput`.
- `expand` is added to the tools automatically.

## Anthropic and OpenAI SDKs

When you run the agent loop yourself, one call per model response runs your tools and returns what to send back: each output shrunk, `expand` answered, and a tool that throws reported to the model as an error. `run(name, args)` returns your tool's raw output (sync or async); your app keeps it.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { expandTool, toolResults } from "contextwaise/anthropic";

const response = await anthropic.messages.create({ model, max_tokens, messages, tools: [...myTools, expandTool] });
messages.push({ role: "assistant", content: response.content });
if (response.stop_reason === "tool_use") {
  messages.push({ role: "user", content: await toolResults(cw, response, runTool, { request: question }) });
}
```

```ts
import { expandTool, expandToolResponses, functionOutputs, toolMessages } from "contextwaise/openai";

// Chat Completions
const message = completion.choices[0].message;
// A message doesn't carry usage: pass it so the dashboard can count what expands cost.
messages.push(message, ...(await toolMessages(cw, message, runTool, { request: question, promptTokens: completion.usage?.prompt_tokens })));

// Responses API
input.push(...response.output, ...(await functionOutputs(cw, response, runTool, { request: question })));
```

- `request` is the user's request: with the text the model wrote before each call, it tells relevance what the agent is after.
- The adapters read the providers' response shapes; neither SDK is a dependency.
- Tool calls in one response run in parallel. `expand` is reserved as a tool name.

## Options

| Option | Default | What it does |
|---|---|---|
| `apiKey` | `CONTEXTWAISE_API_KEY` | Your Contextwaise key (`sw_live_…`). Relevance is then judged by the API (Jev), which means parts of large tool outputs are sent for scoring: see [What leaves your machine](#what-leaves-your-machine). Without a key, nothing leaves your machine and only the local cleanup runs: noise is removed, nothing relevant is ever cut. |
| `baseUrl` | `CONTEXTWAISE_URL` | Where your Contextwaise app runs. Required with a key. |
| `agent` | — | Groups this agent's results on the dashboard. |
| `maxTokens` | `600` | Budget for the model's view of one tool result. |
| `budgets` | — | Per-tool budgets, e.g. `{ read_file: 1500 }`: files up to that size reach the model whole. |
| `full` | — | Tools whose output always reaches the model whole. |
| `ledger` | in memory, last 5,000 calls | Where originals and decisions live. Plug in Redis or a database for multi-process agents. |
| `onEvent` | — | Every decision (`shrink`, `replay`, `expand`, `api_error`), for logs. |

The API is never in the agent's way: scoring times out after 4 s and is then skipped for 30 s; meanwhile the model reads the cleaned output whole (nothing is cut without the API); reports are batched in the background and dropped if they can't be sent. In scripts and serverless functions, `await cw.flush()` before exiting.

## What leaves your machine

Without an API key: nothing. Cleanup, budgets, the ledger and `expand` all run locally.

With an API key, the SDK makes two kinds of calls to your Contextwaise app:

| Call | When | What is sent | What the app keeps |
|---|---|---|---|
| **Scoring** | Only when a cleaned tool output is larger than its budget, and when the agent calls `expand` with a question | The tool call id and tool name; the intent (the user's latest message, any text the model wrote before the call, and the call's argument values); and the cleaned output in sections, with dates, times, long numbers and hex ids removed | The scores (cached 7 days by call id, so a replay gets the same view) and a usage record: tool name, call id, token counts. **No text is stored.** |
| **Reports** | After every tool result and every `expand` | Tool name, call id, sizes, mode and timing; for an `expand`, the input size of the model call that asked for it | All of it, for your dashboard. Reports never contain tool output or intent. |

To score, the app forwards the intent and sections to **TypeSafe (Jev)**, its relevance model. Outputs that fit their budget, tools listed in `full`, and replays are never sent anywhere.

Build: `npm run build` (compiled ESM + types in `dist/`).

## Demo

A Vercel AI SDK agent with six tools (repo listing, files, tests, logs, orders API, docs page) and a live page that shows everything behind the scenes: each model call with its cache reads, writes and cost, each raw tool output, and each Contextwaise decision, against what the same requests would have cost without it.

```bash
cd sdk
npm install
npm run demo          # http://localhost:4100
```

- With `CONTEXTWAISE_API_KEY` and `CONTEXTWAISE_URL` in `sdk/typescript/.env`, relevance comes from your Contextwaise app (Jev) and every result appears on its "Tool results" page.
- With `OPENAI_API_KEY` in `sdk/typescript/.env`, the agent runs on a **real** OpenAI model (`OPENAI_MODEL`, default `gpt-6.1-sol`). This costs money: a few cents per question. "With" costs come from OpenAI's own usage report; "without" is an estimate (the same requests with raw outputs, replayed through a cache simulator, never sent).
- Without a key, or with `DEMO_SIMULATED=1`, a free scripted model plays the agent and bills itself like Claude's prompt cache.

## Tests

```bash
npm test           # offline: the API and the models are stubs
npm run test:e2e   # live: real Claude and OpenAI models and a running Contextwaise app
```

`test:e2e` needs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CONTEXTWAISE_API_KEY` and `CONTEXTWAISE_URL` (from the environment or `.env`). Each case also runs without Contextwaise, and prints the input tokens both runs were billed.

## License

[MIT](LICENSE)
