import type { Tool } from "./types.js";

const SEARCH_URL = "https://api.github.com/search/repositories";
const TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 10;
const ALLOWED_SORTS = ["stars", "forks", "updated"] as const;
type SortOption = (typeof ALLOWED_SORTS)[number];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeLimit(raw: unknown): number {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(num)));
}

function isSortOption(v: unknown): v is SortOption {
  return typeof v === "string" && (ALLOWED_SORTS as readonly string[]).includes(v);
}

function mapRepo(item: unknown) {
  if (!isRecord(item)) return null;
  const fullName = typeof item.full_name === "string" ? item.full_name : "";
  const url = typeof item.html_url === "string" ? item.html_url : "";
  if (!fullName && !url) return null;
  return {
    full_name: fullName,
    description: typeof item.description === "string" ? item.description : "",
    stars: typeof item.stargazers_count === "number" ? item.stargazers_count : 0,
    language: typeof item.language === "string" ? item.language : null,
    url,
  };
}

type GithubInput = { query?: unknown; limit?: unknown; sort?: unknown };

export const searchGithub: Tool = {
  spec: {
    name: "search_github",
    description:
      "Ищет публичные репозитории на GitHub по текстовому запросу. Возвращает список: полное имя " +
      "(владелец/репозиторий), описание, число звёзд, основной язык и ссылку. Поддерживает " +
      "квалификаторы GitHub в запросе (напр. 'telegram bot language:typescript', 'stars:>100'). " +
      "limit — сколько вернуть (1–10, по умолчанию 5). sort — stars, forks или updated; без него по релевантности.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Поисковый запрос. Можно с квалификаторами GitHub (language:python, stars:>100, user:octocat).",
        },
        limit: { type: "number", description: "Сколько вернуть: 1–10, по умолчанию 5." },
        sort: {
          type: "string",
          enum: ["stars", "forks", "updated"],
          description: "Сортировка: stars, forks, updated. Если не указано — по релевантности.",
        },
      },
      required: ["query"],
    },
  },
  run: async (input) => {
    const { query: rawQuery, limit: rawLimit, sort: rawSort } = (input ?? {}) as GithubInput;
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (!query) return { error: "Не указан поисковый запрос (query не может быть пустым)." };

    const limit = normalizeLimit(rawLimit);
    let sort: SortOption | undefined;
    if (rawSort !== undefined && rawSort !== null && rawSort !== "") {
      if (!isSortOption(rawSort)) {
        return { error: `Недопустимое значение sort: ${String(rawSort)}. Допустимо: stars, forks, updated.` };
      }
      sort = rawSort;
    }

    const params = new URLSearchParams();
    params.set("q", query);
    params.set("per_page", String(limit));
    if (sort) params.set("sort", sort);

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "ajax-bot",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token && token.trim() !== "") headers.Authorization = `Bearer ${token.trim()}`;

    try {
      const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const apiMessage = isRecord(body) && typeof body.message === "string" ? body.message : null;

      if (!res.ok) {
        if (res.status === 403 || res.status === 429) {
          const hint = token
            ? " Подождите немного и повторите."
            : " Чтобы поднять лимит, добавьте переменную GITHUB_TOKEN в Railway.";
          return { error: `Превышен лимит или доступ запрещён GitHub (статус ${res.status}).${hint}` };
        }
        if (res.status === 422) {
          return { error: `Ошибка в поисковом запросе (422)${apiMessage ? `: ${apiMessage}` : ""}. Проверьте синтаксис.` };
        }
        return { error: `GitHub API вернул ошибку ${res.status}${apiMessage ? `: ${apiMessage}` : ""}.` };
      }

      const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
      const results = items.map(mapRepo).filter((r): r is NonNullable<ReturnType<typeof mapRepo>> => r !== null);
      return { query, count: results.length, results };
    } catch (e) {
      const msg = e instanceof Error && e.name === "TimeoutError" ? "превышено время ожидания" : String(e);
      return { error: `Не удалось выполнить запрос к GitHub: ${msg}.` };
    }
  },
};
