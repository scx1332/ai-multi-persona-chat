# ollamachat

Minimal chat UI over Ollama — Bun backend (zero npm deps), Postgres storage,
thinking models supported, **no tools ever injected**. Personas with editable
system prompts; chats and reasoning stored in the database.

Two generation modes, selectable per chat:

- **chat** (default) — `/api/chat` with `think: true/false`. No `tools` are
  ever passed, so the template's tool section renders empty: the model sees
  only your system prompt and the conversation. Thinking is handled by Ollama
  at the token level and arrives pre-separated — this is the reliable way to
  get `<think>` reasoning out of qwen3 / deepseek-r1.
- **raw** — `/api/generate` with `raw: true`. Ollama's template is bypassed
  entirely and the exact prompt is assembled in `template.ts` (ChatML by
  default, Llama 3 auto-detected; qwen3's ` /think` soft switch supported).
  Full byte-level control — but note that thinking is unreliable in this mode:
  Ollama's chat path does token-level `<think>` handling that a raw text
  prompt cannot reproduce (measured 0/5 thinking in raw vs 5/5 in chat mode on
  qwen3:1.7b with byte-identical prompts). If a model answers entirely inside
  an unclosed `<think>` block, the server promotes the reasoning to the answer
  so nothing is lost.

In both modes the stream is NDJSON of `{t: "think"|"text"|"promote"|"error"|"done", d}`
events; thinking and answer are stored in separate columns.

## Run (Docker)

```sh
docker compose up -d --build
docker compose exec ollama ollama pull qwen3:0.6b   # or any model you like
```

Open http://localhost:3000 — pick a model + persona, edit the system prompt,
start chatting.

## Run (local dev)

Needs a local Postgres and Ollama, then:

```sh
DATABASE_URL=postgres://user:pass@localhost:5432/ollamachat bun run server.ts
```

## Config (env vars)

| Var | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://ollamachat:ollamachat@localhost:5432/ollamachat` | Postgres connection |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `PORT` | `3000` | HTTP port |
| `NUM_CTX` | `8192` | Context window passed to Ollama |
| `PROMPT_TEMPLATE` | auto | Force `chatml` or `llama3` |

## Layout

- `server.ts` — HTTP routes + streaming think/text parser
- `template.ts` — raw prompt templates (add your own here)
- `db.ts` — schema (`personas`, `chats`, `messages`) + seed personas
- `public/index.html` — the whole frontend
