import { sql, initDb } from "./db";
import { templateFor, type ChatMessage } from "./template";

const indexHtml = Bun.file(new URL("./public/index.html", import.meta.url).pathname);

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const PORT = Number(process.env.PORT ?? 3000);

const json = (data: unknown, status = 400) =>
  Response.json(data, { status: typeof data === "object" && data && "error" in (data as any) ? status : 200 });

// Incremental parser that splits a raw token stream into "think" and "text"
// channels, handling <think> tags split across chunk boundaries.
function makeThinkParser(emit: (t: "think" | "text", d: string) => void) {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let mode: "text" | "think" = "text";
  let buf = "";

  const holdbackLen = (s: string, tag: string) => {
    // length of the longest suffix of s that is a prefix of tag
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
      if (tag.startsWith(s.slice(s.length - n))) return n;
    }
    return 0;
  };

  return {
    push(chunk: string) {
      buf += chunk;
      while (true) {
        const tag = mode === "text" ? OPEN : CLOSE;
        const i = buf.indexOf(tag);
        if (i >= 0) {
          const before = buf.slice(0, i);
          if (before) emit(mode === "text" ? "text" : "think", before);
          buf = buf.slice(i + tag.length);
          mode = mode === "text" ? "think" : "text";
          continue;
        }
        const hold = holdbackLen(buf, tag);
        const flushable = buf.slice(0, buf.length - hold);
        if (flushable) emit(mode === "text" ? "text" : "think", flushable);
        buf = buf.slice(buf.length - hold);
        break;
      }
    },
    end() {
      if (buf) emit(mode === "text" ? "text" : "think", buf);
      buf = "";
    },
  };
}

// Repetition watchdog: fires when the tail of the output (PROBE chars) has
// appeared REPEATS+ times within the recent WINDOW. Catches sentence-level
// loops directly; short-period loops ("ha ha ha…") are caught because a long
// enough run makes any tail-sized slice repeat throughout the window.
function makeLoopWatchdog() {
  if (process.env.WATCHDOG === "off") return { push: (_: string) => false };
  const PROBE = Number(process.env.WATCHDOG_PROBE ?? 90);
  const REPEATS = Number(process.env.WATCHDOG_REPEATS ?? 4);
  const WINDOW = Number(process.env.WATCHDOG_WINDOW ?? 6000);
  const CHECK_EVERY = 200;
  let buf = "";
  let since = 0;
  return {
    push(d: string): boolean {
      buf = (buf + d).slice(-WINDOW);
      since += d.length;
      if (since < CHECK_EVERY || buf.length < PROBE * REPEATS) return false;
      since = 0;
      const probe = buf.slice(-PROBE);
      let count = 0;
      let i = 0;
      while ((i = buf.indexOf(probe, i)) !== -1) {
        count++;
        i += PROBE;
      }
      return count >= REPEATS;
    },
  };
}

async function streamChat(chatId: number, userContent: string): Promise<Response> {
  const [chat] = await sql`SELECT * FROM chats WHERE id = ${chatId}`;
  if (!chat) return json({ error: "chat not found" }, 404);

  const history: ChatMessage[] = (
    await sql`SELECT role, content FROM messages WHERE chat_id = ${chatId} ORDER BY id`
  ).map((m: any) => ({ role: m.role, content: m.content }));

  await sql`INSERT INTO messages (chat_id, role, content) VALUES (${chatId}, 'user', ${userContent})`;
  if (history.length === 0) {
    const title = userContent.slice(0, 60);
    await sql`UPDATE chats SET title = ${title} WHERE id = ${chatId}`;
  }
  history.push({ role: "user", content: userContent });

  console.log(`chat ${chatId}: generating with ${chat.model} (mode=${chat.mode}, think=${chat.think})`);
  const options = { num_ctx: Number(process.env.NUM_CTX ?? 8192) };
  let upstream: Response;
  if (chat.mode === "raw") {
    // Raw token mode: we assemble the exact prompt (template.ts), Ollama
    // applies no template of its own. Thinking depends on the model emitting
    // <think> tags in plain text — flaky on some models; see README.
    const tmpl = templateFor(chat.model);
    const prompt = tmpl.build(chat.system_prompt, history, chat.think);
    upstream = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: chat.model,
        prompt,
        raw: true,
        stream: true,
        options: { ...options, stop: tmpl.stop },
      }),
    });
  } else {
    // Chat mode: Ollama handles thinking at the token level (reliable). We
    // never pass `tools`, so the template's tool section renders empty —
    // the model sees only our system prompt and the conversation.
    const body = (think?: boolean) =>
      JSON.stringify({
        model: chat.model,
        messages: [{ role: "system", content: chat.system_prompt }, ...history],
        stream: true,
        ...(think === undefined ? {} : { think }),
        options,
      });
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(chat.think),
    });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      // Models without thinking support reject the `think` flag — retry plain.
      if (/think/i.test(errText)) {
        upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body(undefined),
        });
      } else {
        return json({ error: `ollama: ${errText}` }, 502);
      }
    }
  }
  if (!upstream.ok || !upstream.body) {
    const msg = await upstream.text().catch(() => upstream.statusText);
    return json({ error: `ollama: ${msg}` }, 502);
  }

  let thinking = "";
  let content = "";
  let saved = false;
  const encoder = new TextEncoder();

  const saveAssistant = async () => {
    if (saved || (!content.trim() && !thinking.trim())) return;
    saved = true;
    // Weak models sometimes answer inside <think> and stop without closing
    // the tag — promote the reasoning to the answer so it isn't lost.
    if (!content.trim()) {
      content = thinking;
      thinking = "";
    }
    await sql`
      INSERT INTO messages (chat_id, role, content, thinking)
      VALUES (${chatId}, 'assistant', ${content.trim()}, ${thinking.trim() || null})`;
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {} // stream already closed (client stopped) — drop silently
      };
      const watchdog = makeLoopWatchdog();
      let looped = false;
      const parser = makeThinkParser((t, d) => {
        if (t === "think") thinking += d;
        else content += d;
        if (watchdog.push(d)) looped = true;
        send({ t, d });
      });
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let lineBuf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lineBuf += decoder.decode(value, { stream: true });
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            const evt = JSON.parse(line);
            if (evt.response) parser.push(evt.response); // generate (raw) shape
            if (evt.message?.thinking) {
              thinking += evt.message.thinking; // chat shape: pre-separated
              if (watchdog.push(evt.message.thinking)) looped = true;
              send({ t: "think", d: evt.message.thinking });
            }
            if (evt.message?.content) parser.push(evt.message.content);
            if (evt.error) {
              console.error(`chat ${chatId}: upstream error event:`, evt.error);
              send({ t: "error", d: evt.error });
            }
          }
          if (looped) {
            console.log(`chat ${chatId}: watchdog abort after ${thinking.length}+${content.length} chars`);
            await reader.cancel().catch(() => {});
            break;
          }
        }
        parser.end();
        const promoted = !content.trim() && thinking.trim();
        await saveAssistant();
        if (promoted) send({ t: "promote" });
        if (looped) send({ t: "error", d: "generation stopped: repeating output detected" });
        send({ t: "done" });
      } catch (e: any) {
        // Upstream died mid-stream (cloud disconnect etc.) — keep the partial
        // reply instead of dropping it.
        console.error(`chat ${chatId}: stream error after ${thinking.length}+${content.length} chars:`, e);
        parser.end();
        await saveAssistant().catch((err) => console.error(`chat ${chatId}: save failed:`, err));
        send({ t: "error", d: `generation interrupted: ${String(e?.message ?? e)}` });
      } finally {
        controller.close();
      }
    },
    async cancel() {
      // Client hit Stop (or navigated away) — abort upstream, keep partial.
      upstream.body?.cancel().catch(() => {});
      console.log(`chat ${chatId}: client cancelled after ${thinking.length}+${content.length} chars`);
      await saveAssistant().catch((err) => console.error(`chat ${chatId}: save failed:`, err));
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
  });
}

await initDb();

Bun.serve({
  port: PORT,
  idleTimeout: 240,
  routes: {
    "/": () => new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),

    "/api/models": async () => {
      const r = await fetch(`${OLLAMA_URL}/api/tags`);
      const data: any = await r.json();
      return json({ models: (data.models ?? []).map((m: any) => m.name) });
    },

    "/api/personas": {
      GET: async () => json(await sql`SELECT * FROM personas ORDER BY id`),
      POST: async (req) => {
        const { name, system_prompt } = await req.json();
        if (!name || !system_prompt) return json({ error: "name and system_prompt required" });
        const [p] = await sql`
          INSERT INTO personas (name, system_prompt) VALUES (${name}, ${system_prompt})
          ON CONFLICT (name) DO UPDATE SET system_prompt = EXCLUDED.system_prompt
          RETURNING *`;
        return json(p);
      },
    },
    "/api/personas/:id": {
      DELETE: async (req) => {
        await sql`DELETE FROM personas WHERE id = ${Number(req.params.id)}`;
        return json({ ok: true });
      },
    },

    "/api/chats": {
      GET: async () =>
        json(await sql`
          SELECT c.id, c.title, c.model, c.created_at, p.name AS persona_name
          FROM chats c LEFT JOIN personas p ON p.id = c.persona_id
          ORDER BY c.id DESC`),
      POST: async (req) => {
        const { persona_id, model, system_prompt, think, mode } = await req.json();
        if (!model) return json({ error: "model required" });
        if (mode && !["chat", "raw"].includes(mode)) return json({ error: "mode must be chat or raw" });
        let sys = system_prompt;
        if (!sys && persona_id) {
          const [p] = await sql`SELECT system_prompt FROM personas WHERE id = ${persona_id}`;
          sys = p?.system_prompt;
        }
        if (!sys) return json({ error: "system_prompt or persona_id required" });
        const [chat] = await sql`
          INSERT INTO chats (persona_id, model, system_prompt, think, mode)
          VALUES (${persona_id ?? null}, ${model}, ${sys}, ${think ?? true}, ${mode ?? "chat"}) RETURNING *`;
        return json(chat);
      },
    },
    "/api/chats/:id": {
      GET: async (req) => {
        const id = Number(req.params.id);
        const [chat] = await sql`SELECT * FROM chats WHERE id = ${id}`;
        if (!chat) return json({ error: "not found" }, 404);
        const messages = await sql`SELECT * FROM messages WHERE chat_id = ${id} ORDER BY id`;
        return json({ ...chat, messages });
      },
      PATCH: async (req) => {
        const id = Number(req.params.id);
        const body = await req.json();
        if (body.mode && !["chat", "raw"].includes(body.mode)) return json({ error: "mode must be chat or raw" });
        const [chat] = await sql`SELECT * FROM chats WHERE id = ${id}`;
        if (!chat) return json({ error: "not found" }, 404);
        let sys = body.system_prompt ?? chat.system_prompt;
        let personaId = body.persona_id === undefined ? chat.persona_id : body.persona_id;
        // Switching persona (without an explicit prompt) adopts its prompt
        if (body.persona_id && body.system_prompt === undefined) {
          const [p] = await sql`SELECT system_prompt FROM personas WHERE id = ${body.persona_id}`;
          if (!p) return json({ error: "persona not found" }, 404);
          sys = p.system_prompt;
        }
        const [updated] = await sql`
          UPDATE chats SET
            model = ${body.model ?? chat.model},
            persona_id = ${personaId ?? null},
            system_prompt = ${sys},
            think = ${body.think ?? chat.think},
            mode = ${body.mode ?? chat.mode}
          WHERE id = ${id} RETURNING *`;
        return json(updated);
      },
      DELETE: async (req) => {
        await sql`DELETE FROM chats WHERE id = ${Number(req.params.id)}`;
        return json({ ok: true });
      },
    },
    "/api/chats/:id/messages": {
      POST: async (req) => {
        const { content } = await req.json();
        if (!content?.trim()) return json({ error: "content required" });
        return streamChat(Number(req.params.id), content.trim());
      },
    },
  },
});

console.log(`ollamachat listening on http://localhost:${PORT} (ollama: ${OLLAMA_URL})`);
