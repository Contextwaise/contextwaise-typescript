// OpenAI adapters: you run the loop, Contextwaise shrinks what goes back. Both APIs:
//
//   // Chat Completions
//   const message = completion.choices[0].message;
//   messages.push(message);
//   messages.push(...await toolMessages(cw, message, run, { promptTokens: completion.usage?.prompt_tokens }));
//
//   // Responses
//   const response = await client.responses.create({ ... });
//   input.push(...response.output);
//   input.push(...await functionOutputs(cw, response, run));

import type { Contextwaise } from "./core.ts";
import { EXPAND_TOOL, parseArgs, runToolCalls, type CallOptions, type RunTool, type ToolCall } from "./tool-calls.ts";

/** The `expand` tool for Chat Completions: add it to `tools`. */
export const expandTool = { type: "function", function: { name: EXPAND_TOOL.name, description: EXPAND_TOOL.description, parameters: EXPAND_TOOL.parameters } } as const;

/** The `expand` tool for the Responses API. Not strict: `question` is optional. */
export const expandToolResponses = { type: "function", name: EXPAND_TOOL.name, description: EXPAND_TOOL.description, parameters: EXPAND_TOOL.parameters, strict: false } as const;

/** The parts of a Chat Completions message this adapter reads. */
export type ChatMessage = { content?: string | null; tool_calls?: readonly { id: string; type?: string; function?: { name: string; arguments: string } | null }[] | null };
export type ChatToolMessage = { role: "tool"; tool_call_id: string; content: string };

/**
 * Runs a Chat Completions message's tool calls and returns the `tool` messages to send
 * back, in order: each output shrunk, `expand` answered, failures as "Error: …" text.
 * `promptTokens`: the completion's `usage.prompt_tokens` (a message doesn't carry it), so
 * the dashboard can count what each expand cost.
 */
export async function toolMessages(cw: Contextwaise, message: ChatMessage, run: RunTool, options: CallOptions & { promptTokens?: number } = {}): Promise<ChatToolMessage[]> {
  const said = (message.content ?? "").trim();
  const calls: ToolCall[] = (message.tool_calls ?? [])
    .filter((c) => c.function)
    .map((c) => ({ id: c.id, name: c.function!.name, textBefore: said, ...parseArgs(c.function!.arguments) }));
  const outcomes = await runToolCalls(cw, calls, run, options, "openai", options.promptTokens);
  return outcomes.map((o) => ({ role: "tool", tool_call_id: o.id, content: o.content }));
}

/** The parts of a Responses API response this adapter reads. */
// Fields are optional and nullable: these accept the openai package's own types as they are.
export type ResponsesResponse = {
  output: readonly { type: string; call_id?: string | null; name?: string | null; arguments?: unknown; content?: readonly { type: string; text?: string | null }[] | null }[];
  usage?: { input_tokens?: number | null } | null;
};
export type FunctionCallOutput = { type: "function_call_output"; call_id: string; output: string };

/**
 * Runs a Responses API response's function calls and returns the `function_call_output`
 * items to send back, in order: each output shrunk, `expand` answered, failures as "Error: …".
 */
export async function functionOutputs(cw: Contextwaise, response: ResponsesResponse, run: RunTool, options: CallOptions = {}): Promise<FunctionCallOutput[]> {
  const calls: ToolCall[] = [];
  let said = "";
  for (const item of response.output) {
    if (item.type === "message") said += `${(item.content ?? []).map((p) => p.text ?? "").join("")} `;
    else if (item.type === "function_call" && item.call_id && item.name) calls.push({ id: item.call_id, name: item.name, textBefore: said.trim(), ...parseArgs(item.arguments) });
  }
  const outcomes = await runToolCalls(cw, calls, run, options, "openai", response.usage?.input_tokens ?? undefined);
  return outcomes.map((o) => ({ type: "function_call_output", call_id: o.id, output: o.content }));
}
