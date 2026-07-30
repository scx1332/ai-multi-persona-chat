import { SQL } from "bun";

export const sql = new SQL(
  process.env.DATABASE_URL ?? "postgres://ollamachat:ollamachat@localhost:5432/ollamachat"
);

export async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS personas (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      system_prompt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
      model TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      think BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS think BOOLEAN NOT NULL DEFAULT true`;
  await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'chat'`;
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      thinking TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  // Seed default personas on first run
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM personas`;
  if (count === 0) {
    const seeds = [
      {
        name: "Assistant",
        system_prompt: "You are a helpful, concise assistant. Answer directly and clearly.",
      },
      {
        name: "Socratic Tutor",
        system_prompt:
          "You are a patient tutor. Never give the answer outright; guide the user with questions and hints so they reach the answer themselves.",
      },
      {
        name: "Code Reviewer",
        system_prompt:
          "You are a senior software engineer doing code review. Point out bugs, edge cases and simplifications. Be specific and terse.",
      },
    ];
    for (const p of seeds) {
      await sql`INSERT INTO personas (name, system_prompt) VALUES (${p.name}, ${p.system_prompt})`;
    }
  }
}
