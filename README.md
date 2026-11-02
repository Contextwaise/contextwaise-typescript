# Contextwaise

[![npm: contextwaise](https://img.shields.io/npm/v/contextwaise?label=contextwaise)](https://www.npmjs.com/package/contextwaise)
[![npm: @contextwaise/core](https://img.shields.io/npm/v/@contextwaise/core?label=@contextwaise/core)](https://www.npmjs.com/package/@contextwaise/core)
[![PyPI: contextwaise](https://img.shields.io/pypi/v/contextwaise?label=pypi)](https://pypi.org/project/contextwaise/)

Cut what your LLM pays to read, without changing what it can answer.

Agents resend every tool result on every later turn, and apps send whole documents
when a few paragraphs would do. Contextwaise keeps the part of that context relevant
to the current step and drops the noise, while staying safe for prompt caching: a
decision is made once and replayed, so the history your model sees never changes.

| Package | What it does |
|---|---|
| [`contextwaise`](sdk/typescript) | The agent SDK. Shrinks each tool result the moment it returns, keeps the original, and gives the model an `expand` tool to get any part back. Adapters for the Vercel AI SDK, the Anthropic SDK and the OpenAI SDK (Chat Completions and Responses). |
| [`contextwaise` (Python)](https://github.com/Contextwaise/contextwaise-python) | The same agent SDK for Python 3.10+, sync and asyncio, with adapters for the Vercel AI SDK for Python, the Anthropic SDK and the OpenAI SDK. Makes the same decisions as the TypeScript SDK. |
| [`@contextwaise/core`](core) | The rules that decide what is cut: cleanup by content type, selection (relevance threshold, near-duplicates, token budget), cache-safe conversations, and model prices. Pure, no I/O. |

Everything that decides what is removed from your context, and everything that runs
on your machine, is in this repository. Relevance scoring is done by the hosted
Contextwaise API; without an API key the SDK only runs the local cleanup and nothing
leaves your machine. See [What leaves your machine](sdk/typescript/README.md#what-leaves-your-machine).

## Quick start

```bash
npm install contextwaise
```

```ts
import { createContextwaise } from "contextwaise";
import { withContextwaise } from "contextwaise/ai-sdk";

const cw = createContextwaise({ agent: "support-triage", budgets: { read_file: 1500 } });
const { model, tools } = withContextwaise(cw, { model, tools: myTools });
```

Full options in the [SDK README](sdk/typescript/README.md).

## Development

Requires Node 22.18 or later (tests run TypeScript directly).

```bash
npm install          # links core into the SDK
npm test             # core, then SDK
npm run typecheck
npm run build        # core/dist and sdk/typescript/dist
```

The SDK reads the core's source during development (the `contextwaise-source` export
condition), so changes to `core/` need no rebuild. Published packages use `dist/`.

The Python SDK lives in its own repository, [Contextwaise/contextwaise-python](https://github.com/Contextwaise/contextwaise-python).

## License

[MIT](LICENSE)
