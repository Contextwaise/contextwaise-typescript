// Anthropic Messages API adapter: you run the loop, Contextwaise shrinks what goes back.
//
//   const response = await client.messages.create({ model, messages, tools: [...myTools, expandTool] });
//   messages.push({ role: "assistant", content: response.content });
//   messages.push({ role: "user", content: await toolResults(cw, response, runTool, { request }) });

import type { Contextwaise } from "./core.ts";
import { EXPAND_TOOL, runToolCalls, type CallOptions, type RunTool, type ToolCall } from "./tool-calls.ts";

/** The `expand` tool in Anthropic's format: add it to `tools`. */
export const expandTool = { name: EXPAND_TOOL.name, description: EXPAND_TOOL.description, input_schema: EXPAND_TOOL.parameters };

/** The parts of a Messages API response this adapter reads. */
export type AnthropicResponse = {
  content: readonly { type: string; text?: string | null; id?: string | null; name?: string | null; input?: unknown }[];
  usage?: { input_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null;
};

/** A `tool_result` block, ready to send in the next user message. */
export type AnthropicToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/**
 * Runs the response's tool calls and returns their `tool_result` blocks, in order: each
 * output shrunk, `expand` answered, failures marked `is_error`. Empty when the model
 * called no tool. `run` keeps the raw outputs on your side.
 */
export async function toolResults(cw: Contextwaise, response: AnthropicResponse, run: RunTool, options: CallOptions = {}): Promise<AnthropicToolResult[]> {
  const calls: ToolCall[] = [];
  let said = "";
  for (const block of response.content) {
    if (block.type === "text") said += `${block.text ?? ""} `;
    else if (block.type === "tool_use" && block.id && block.name) calls.push({ id: block.id, name: block.name, args: block.input ?? {}, textBefore: said.trim() });
  }
  // Anthropic counts cached input apart from the rest: the call read all three.
  const usage = response.usage;
  const contextTokens = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : undefined;
  const outcomes = await runToolCalls(cw, calls, run, options, "anthropic", contextTokens);
  return outcomes.map((o) => ({ type: "tool_result", tool_use_id: o.id, content: o.content, ...(o.isError && { is_error: true }) }));
}
