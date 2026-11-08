import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Не задана переменная окружения: DATABASE_URL");

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes(".railway.internal")
    ? undefined
    : { rejectUnauthorized: false },
});

export type Turn = { role: "user" | "assistant"; content: string };
export type Subagent = {
  id: number;
  name: string;
  description: string;
  tools: string[];
  status: string;
};

export async function initDb() {
  pool.on("error", (e) => console.error("Ошибка пула БД:", e));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subagents (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      tools TEXT[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("База готова: messages + subagents.");
}

// --- Память разговора ---
export async function addTurn(role: Turn["role"], content: string) {
  await pool.query("INSERT INTO messages (role, content) VALUES ($1, $2)", [role, content]);
}

export async function getRecentTurns(limit: number): Promise<Turn[]> {
  const res = await pool.query<Turn>(
    "SELECT role, content FROM messages ORDER BY id DESC LIMIT $1",
    [limit]
  );
  return res.rows.reverse();
}

export async function clearMemory() {
  await pool.query("DELETE FROM messages");
}

// --- Реестр субагентов ---
export async function listSubagents(): Promise<Subagent[]> {
  const res = await pool.query<Subagent>(
    "SELECT id, name, description, tools, status FROM subagents ORDER BY id"
  );
  return res.rows;
}

export async function addSubagent(name: string, description: string, tools: string[]) {
  const res = await pool.query<{ id: number }>(
    "INSERT INTO subagents (name, description, tools) VALUES ($1, $2, $3) RETURNING id",
    [name, description, tools]
  );
  return res.rows[0].id;
}
