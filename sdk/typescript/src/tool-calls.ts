// What every "you run the loop" adapter shares (anthropic.ts, openai.ts): tool calls in,
// what to send back out. The provider files only read their response shape and format
// their result type; the decisions live here, once.

import type { Contextwaise } from "./core.ts";

/** A JSON Schema object for tool parameters, typed loosely enough for every provider SDK's tool type. */
export type ToolParameters = { type: "object"; properties: Record<string, { type: string; description?: string }>; required: string[]; additionalProperties: boolean };

/** The `expand` tool, provider-neutral: each adapter states it in its own format. */
export const EXPAND_TOOL: { name: "expand"; description: string; parameters: ToolParameters } = {
  name: "expand",
  description:
    "Get back parts of a tool result that Contextwaise trimmed. Pass the ref shown in the result's [contextwaise …] note, and a question describing what you need.",
  parameters: {
    type: "object",
    properties: { ref: { type: "string" }, question: { type: "string", description: "What you are looking for in the full output." } },
    required: ["ref"],
    additionalProperties: false,
  },
};

/**
 * Runs one of your tools. Return its raw output (text or any JSON value), sync or async:
 * Contextwaise shrinks it before the model reads it. Throw to report a failure to the model.
 */
export type RunTool = (name: string, args: any, call: { id: string }) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

export type CallOptions = {
  /** The user's request this turn is about. With the text the model wrote before a call, it tells relevance what the agent is after. */
  request?: string;
};

/** A tool call, whatever the provider: `textBefore` is what the model wrote before it, `args` the parsed arguments. */
export type ToolCall = { id: string; name: string; args: unknown; textBefore: string; argsError?: string };
export type ToolOutcome = { id: string; content: string; isError: boolean };

/**
 * Runs every call in parallel and returns what the model should read for each, in order:
 * `expand` is answered by Contextwaise, other tools by `run` with their output shrunk, and
 * a tool that throws (or arguments that don't parse) becomes an error the model can see.
 * `contextTokens`: the input tokens of the model call that made them (see `expand`).
 */
export async function runToolCalls(cw: Contextwaise, calls: ToolCall[], run: RunTool, options: CallOptions, integration: string, contextTokens: number | undefined): Promise<ToolOutcome[]> {
  return Promise.all(
    calls.map(async (call): Promise<ToolOutcome> => {
      if (call.argsError) return { id: call.id, content: `Error: ${call.argsError}`, isError: true };
      if (call.name === EXPAND_TOOL.name) {
        const { ref, question } = (call.args ?? {}) as { ref?: unknown; question?: unknown };
        return { id: call.id, content: await cw.expand(String(ref ?? ""), typeof question === "string" ? question : undefined, { contextTokens }), isError: false };
      }
      cw.noteIntent(call.id, [options.request, call.textBefore].filter(Boolean).join(" "));
      let output: unknown;
      try {
        output = await run(call.name, call.args, { id: call.id });
      } catch (e) {
        return { id: call.id, content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
      const view = await cw.shrink({ callId: call.id, tool: call.name, args: call.args, output, integration });
      return { id: call.id, content: view.text, isError: false };
    }),
  );
}

/** Arguments sent as JSON text (OpenAI): parsed, or the reason they couldn't be. Non-text arguments pass as they are. */
export function parseArgs(json: unknown): { args: unknown; argsError?: string } {
  if (json === null || json === undefined || json === "") return { args: {} };
  if (typeof json !== "string") return { args: json };
  try {
    return { args: JSON.parse(json) };
  } catch {
    return { args: json, argsError: "the tool arguments were not valid JSON" };
  }
}
