// Agent loops written the way an app would, on each provider's own SDK, with or without
// Contextwaise: the only Contextwaise code is the adapter call where tool results go back.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Contextwaise } from "../src/index.ts";
import { expandTool as anthropicExpand, toolResults } from "../src/anthropic.ts";
import { expandTool as chatExpand, expandToolResponses, functionOutputs, toolMessages } from "../src/openai.ts";
import { appLogs, orders, readFile, REPO_PATHS, testRun } from "./fixtures.ts";

export const ANTHROPIC_MODEL = "claude-haiku-5-5";
export const OPENAI_MODEL = "gpt-6-luna";
const MAX_TURNS = 12;

const obj = (props: string[]) => ({ type: "object" as const, properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])), required: props, additionalProperties: false });
const TOOLS: Record<string, { description: string; parameters: ReturnType<typeof obj> }> = {
  get_orders: { description: "List a customer's orders from the orders API (JSON).", parameters: obj(["customer"]) },
  search_logs: { description: "Return today's application logs matching a query.", parameters: obj(["query"]) },
  run_tests: { description: "Run the test suite and return its output.", parameters: obj([]) },
  list_files: { description: "List every file in the repository under a directory, recursively.", parameters: obj(["dir"]) },
  read_file: { description: "Read a source file.", parameters: obj(["path"]) },
  get_invoices: { description: "List a customer's invoices from the billing API.", parameters: obj(["customer"]) },
};

/** The app's own tools (synthetic data). `get_invoices` is down, to test failures. */
export function runTool(name: string, args: Record<string, string>): unknown {
  if (name === "get_orders") return orders(args.customer);
  if (name === "search_logs") return appLogs();
  if (name === "run_tests") return testRun();
  if (name === "list_files") return REPO_PATHS.filter((p) => args.dir === "." || p.startsWith(args.dir.replace(/^\.\//, ""))).join("\n");
  if (name === "read_file") return readFile(args.path.replace(/^\.\//, ""));
  throw new Error("billing API unavailable (503)");
}
/** Without Contextwaise: text as is, anything else as compact JSON. */
const raw = (name: string, args: Record<string, string>) => {
  try {
    const out = runTool(name, args);
    return { content: typeof out === "string" ? out : JSON.stringify(out), isError: false };
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true };
  }
};

export type Run = { text: string; toolCalls: string[]; inputTokens: number; results: [string, string][]; history: unknown[] };

export async function anthropicRun(question: string, names: string[], cw: Contextwaise | null, history: Anthropic.MessageParam[] = []): Promise<Run> {
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: question }];
  const tools: Anthropic.Tool[] = [...names.map((n) => ({ name: n, description: TOOLS[n].description, input_schema: TOOLS[n].parameters })), ...(cw ? [anthropicExpand] : [])];
  const run: Run = { text: "", toolCalls: [], inputTokens: 0, results: [], history: messages };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({ model: ANTHROPIC_MODEL, max_tokens: 1024, tools, messages });
    run.inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    messages.push({ role: "assistant", content: response.content });
    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || !uses.length) {
      run.text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return run;
    }
    run.toolCalls.push(...uses.map((b) => b.name));
    const results: Anthropic.ToolResultBlockParam[] = cw
      ? await toolResults(cw, response, runTool, { request: question })
      : uses.map((b) => { const r = raw(b.name, b.input as Record<string, string>); return { type: "tool_result", tool_use_id: b.id, content: r.content, ...(r.isError && { is_error: true }) }; });
    run.results.push(...uses.map((b, i): [string, string] => [b.name, String(results[i].content)]));
    messages.push({ role: "user", content: results });
  }
  throw new Error(`no answer after ${MAX_TURNS} turns`);
}

export async function chatRun(question: string, names: string[], cw: Contextwaise | null, history: OpenAI.ChatCompletionMessageParam[] = []): Promise<Run> {
  const client = new OpenAI();
  const messages: OpenAI.ChatCompletionMessageParam[] = [...history, { role: "user", content: question }];
  const tools: OpenAI.ChatCompletionTool[] = [...names.map((n) => ({ type: "function" as const, function: { name: n, description: TOOLS[n].description, parameters: TOOLS[n].parameters } })), ...(cw ? [chatExpand] : [])];
  const run: Run = { text: "", toolCalls: [], inputTokens: 0, results: [], history: messages };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // gpt-6-luna takes function tools on Chat Completions only without reasoning.
    const completion = await client.chat.completions.create({ model: OPENAI_MODEL, tools, messages, reasoning_effort: "none" });
    run.inputTokens += completion.usage?.prompt_tokens ?? 0;
    const message = completion.choices[0].message;
    messages.push(message);
    const calls = (message.tool_calls ?? []).filter((c) => c.type === "function");
    if (!calls.length) {
      run.text = message.content ?? "";
      return run;
    }
    run.toolCalls.push(...calls.map((c) => c.function.name));
    const replies: OpenAI.ChatCompletionToolMessageParam[] = cw
      ? await toolMessages(cw, message, runTool, { request: question, promptTokens: completion.usage?.prompt_tokens })
      : calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: raw(c.function.name, JSON.parse(c.function.arguments || "{}")).content }));
    run.results.push(...calls.map((c, i): [string, string] => [c.function.name, String(replies[i].content)]));
    messages.push(...replies);
  }
  throw new Error(`no answer after ${MAX_TURNS} turns`);
}

export async function responsesRun(question: string, names: string[], cw: Contextwaise | null, history: OpenAI.Responses.ResponseInputItem[] = []): Promise<Run> {
  const client = new OpenAI();
  const input: OpenAI.Responses.ResponseInputItem[] = [...history, { role: "user", content: question }];
  const tools: OpenAI.Responses.Tool[] = [...names.map((n) => ({ type: "function" as const, name: n, description: TOOLS[n].description, parameters: TOOLS[n].parameters, strict: false })), ...(cw ? [expandToolResponses] : [])];
  const run: Run = { text: "", toolCalls: [], inputTokens: 0, results: [], history: input };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.responses.create({ model: OPENAI_MODEL, tools, input });
    run.inputTokens += response.usage?.input_tokens ?? 0;
    input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
    const calls = response.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
    if (!calls.length) {
      run.text = response.output_text;
      return run;
    }
    run.toolCalls.push(...calls.map((c) => c.name));
    const outputs: OpenAI.Responses.ResponseInputItem.FunctionCallOutput[] = cw
      ? await functionOutputs(cw, response, runTool, { request: question })
      : calls.map((c) => ({ type: "function_call_output", call_id: c.call_id, output: raw(c.name, JSON.parse(c.arguments || "{}")).content }));
    run.results.push(...calls.map((c, i): [string, string] => [c.name, String(outputs[i].output)]));
    input.push(...outputs);
  }
  throw new Error(`no answer after ${MAX_TURNS} turns`);
}

export const PROVIDERS = {
  anthropic: { key: "ANTHROPIC_API_KEY", run: anthropicRun },
  "openai-chat": { key: "OPENAI_API_KEY", run: chatRun },
  "openai-responses": { key: "OPENAI_API_KEY", run: responsesRun },
} as const;
