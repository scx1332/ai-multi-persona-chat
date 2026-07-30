// Raw prompt templates. We call Ollama with `raw: true`, which bypasses the
// model's built-in chat template entirely — so nothing (tool definitions,
// web-search scaffolding, etc.) is injected besides what we build here.

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type Template = {
  build: (system: string, messages: ChatMessage[], think: boolean) => string;
  stop: string[];
};

// ChatML — used by Qwen (incl. qwen3 thinking models) and many others.
// Qwen3 uses a soft switch trained into the model: " /think" or " /no_think"
// appended to the last user message controls whether it emits a
// <think>…</think> reasoning block.
const chatml: Template = {
  build(system, messages, think) {
    let p = `<|im_start|>system\n${system}<|im_end|>\n`;
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    messages.forEach((m, i) => {
      const suffix = i === lastUser ? (think ? " /think" : " /no_think") : "";
      p += `<|im_start|>${m.role}\n${m.content}${suffix}<|im_end|>\n`;
    });
    p += `<|im_start|>assistant\n`;
    return p;
  },
  stop: ["<|im_end|>"],
};

// Llama 3 instruct family (no native reasoning switch).
const llama3: Template = {
  build(system, messages) {
    let p = `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${system}<|eot_id|>`;
    for (const m of messages) {
      p += `<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`;
    }
    p += `<|start_header_id|>assistant<|end_header_id|>\n\n`;
    return p;
  },
  stop: ["<|eot_id|>"],
};

const templates: Record<string, Template> = { chatml, llama3 };

export function templateFor(model: string): Template {
  const forced = process.env.PROMPT_TEMPLATE;
  if (forced && templates[forced]) return templates[forced];
  if (/llama/i.test(model)) return llama3;
  return chatml;
}
