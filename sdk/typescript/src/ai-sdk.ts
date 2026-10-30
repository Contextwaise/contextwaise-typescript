// Vercel AI SDK adapter. One call wraps the model and the tools:
//
//   const { model, tools } = withContextwaise(cw, { model, tools });
//   await generateText({ model, tools, stopWhen: isStepCount(10), ... });
//
// - Each tool's `toModelOutput` returns Contextwaise's view of the result. This is the
//   AI SDK's own "the model sees this, the app keeps the raw output" hook: raw results
//   stay in `steps[].content` and the UI stream, and `response.messages` store the
//   view, so later turns resend the same bytes (cache-safe). Apps that rebuild history
//   from UI messages call `toModelOutput` again on every turn; the ledger replays it.
// - A model middleware records each tool call's intent, which `toModelOutput` can't
//   see: the user's latest message, plus any text the model wrote before the call
//   (many models, e.g. GPT-6.1, call tools without saying anything first).
// - An `expand` tool is added so the model can get any trimmed part back. Each expand
//   reports the size of the step that asked for it: the extra step it causes costs about
//   as much, and the dashboard counts that against the savings.

import { tokens } from "@contextwaise/core";
import { jsonSchema, tool, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type ToolSet } from "ai";
import type { Contextwaise } from "./core.ts";
import { EXPAND_TOOL } from "./tool-calls.ts";

type ModelV4 = Parameters<typeof wrapLanguageModel>[0]["model"];

/**
 * `full`: calls whose output must reach the model whole, e.g. a file the agent will edit. Schemas
 * and lists of actions are detected and passed whole on their own.
 * `agent`: the agent these tools belong to, for apps hosting many agents on one client (each run
 * wraps its own tools, so each agent's results are grouped under its own name). Default: the client's.
 */
export function withContextwaise<TOOLS extends ToolSet>(cw: Contextwaise, input: { model: ModelV4; tools: TOOLS; full?: (tool: string, args: unknown) => boolean; agent?: string }): { model: LanguageModel; tools: TOOLS } {
  // Tool call id → size of the step that asked for that expand, until it runs.
  const stepTokens = new Map<string, number>();
  const tools = Object.fromEntries(
    Object.entries(input.tools).map(([name, t]) => [
      name,
      {
        ...t,
        toModelOutput: async ({ toolCallId, input: args, output }: { toolCallId: string; input: unknown; output: unknown }) => {
          // Respect a tool's own conversion first, then shrink what it would have sent.
          const own = t.toModelOutput ? await t.toModelOutput({ toolCallId, input: args, output }) : null;
          if (own && own.type !== "text" && own.type !== "json") return own; // images, files, denials: untouched
          const value = own ? own.value : output;
          const result = await cw.shrink({ callId: toolCallId, tool: name, args, output: value, integration: "vercel-ai", model: input.model.modelId, full: input.full?.(name, args), agent: input.agent });
          return { type: "text" as const, value: result.text };
        },
      },
    ]),
  ) as unknown as TOOLS;

  const expand = tool({
    description: EXPAND_TOOL.description,
    inputSchema: jsonSchema<{ ref: string; question?: string }>(EXPAND_TOOL.parameters as never),
    execute: ({ ref, question }, { toolCallId }) => {
      const contextTokens = stepTokens.get(toolCallId);
      stepTokens.delete(toolCallId);
      return cw.expand(ref, question, { contextTokens });
    },
  });

  return { model: wrapLanguageModel({ model: input.model, middleware: intentMiddleware(cw, stepTokens) }), tools: { ...tools, expand } as TOOLS };
}

/**
 * Characters of text in a prompt: every string in it, without JSON syntax. Measured as JSON, a
 * prompt holding JSON tool results counted each of their quotes twice (escaped), over-sizing the
 * conversation and so blocking cuts that would pay.
 */
function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + textLength(v), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((n: number, v) => n + textLength(v), 0);
  return 0;
}

/** The user's latest message in a prompt: what the whole agent turn is for. */
function lastUserText(prompt: unknown): string {
  const messages = prompt as { role: string; content: string | { type: string; text?: string }[] }[];
  const last = [...messages].reverse().find((m) => m.role === "user" && (typeof m.content === "string" || m.content.some((p) => p.type === "text")));
  if (!last) return "";
  return typeof last.content === "string" ? last.content : last.content.map((p) => p.text ?? "").join(" ");
}

/**
 * Records, for every tool call in a model response, the user's request, the text the model
 * wrote before the call, and the size of the step's prompt (an estimate: a stream reports
 * usage only after the tools have started). The size decides how much a cut must save, and
 * for an expand, what the extra step it caused cost.
 */
function intentMiddleware(cw: Contextwaise, stepTokens: Map<string, number>): LanguageModelMiddleware {
  // One prompt per model response: measured once, on its first tool call.
  const sizes = new WeakMap<object, number>();
  const sizeOf = (prompt: unknown) => {
    let size = sizes.get(prompt as object);
    if (size === undefined) sizes.set(prompt as object, (size = Math.ceil(textLength(prompt) / 4)));
    return size;
  };
  const noteCall = (part: { toolCallId: string; toolName: string }, text: string, prompt: unknown) => {
    cw.noteIntent(part.toolCallId, text, { contextTokens: sizeOf(prompt) });
    if (part.toolName === EXPAND_TOOL.name) stepTokens.set(part.toolCallId, sizeOf(prompt));
  };
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      let text = lastUserText(params.prompt) + " ";
      for (const part of result.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "tool-call") noteCall(part, text, params.prompt);
      }
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const { stream, ...rest } = await doStream();
      let text = lastUserText(params.prompt) + " ";
      const watch = new TransformStream({
        transform(part, controller) {
          if (part.type === "text-delta") text += part.delta;
          else if (part.type === "tool-call") noteCall(part, text, params.prompt);
          controller.enqueue(part);
        },
      });
      return { stream: stream.pipeThrough(watch), ...rest };
    },
  };
}
