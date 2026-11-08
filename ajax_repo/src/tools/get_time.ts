import type { Tool } from "./types.js";

const TIME_ZONE = "Asia/Bishkek";

function pad(value: number, length: number = 2): string {
  return String(Math.abs(value)).padStart(length, "0");
}

function getParts(date: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const result: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }
  return result;
}

function pick(parts: Record<string, string>, key: string, fallback: string): string {
  const value = parts[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export const getTime: Tool = {
  spec: {
    name: "get_time",
    description:
      "Возвращает текущие дату и время в Бишкеке (часовой пояс Asia/Bishkek, UTC+6): читаемую строку ДД.ММ.ГГГГ ЧЧ:ММ:СС, дату, время, день недели по-русски, ISO-строку со смещением, UTC ISO, название пояса и смещение. Входных параметров нет.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  run: async (_input: any): Promise<unknown> => {
    try {
      const now = new Date();
      const parts = getParts(now);

      const year = pick(parts, "year", "0000");
      const month = pick(parts, "month", "01");
      const day = pick(parts, "day", "01");
      let hour = pick(parts, "hour", "00");
      const minute = pick(parts, "minute", "00");
      const second = pick(parts, "second", "00");

      if (hour === "24") {
        hour = "00";
      }

      const weekday = new Intl.DateTimeFormat("ru-RU", {
        timeZone: TIME_ZONE,
        weekday: "long",
      }).format(now);

      const localAsUtcMs = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      );
      const nowWholeSecondsMs = Math.floor(now.getTime() / 1000) * 1000;
      const offsetMinutes = Math.round((localAsUtcMs - nowWholeSecondsMs) / 60000);

      const sign = offsetMinutes < 0 ? "-" : "+";
      const absMinutes = Math.abs(offsetMinutes);
      const offset = `${sign}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`;

      const ms = pad(now.getUTCMilliseconds(), 3);

      const date = `${day}.${month}.${year}`;
      const time = `${hour}:${minute}:${second}`;
      const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${offset}`;

      return {
        ok: true,
        readable: `${date} ${time}`,
        date,
        time,
        weekday,
        iso,
        utc_iso: now.toISOString(),
        timezone: TIME_ZONE,
        offset,
        offset_label: `UTC${offset}`,
        unix_ms: now.getTime(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Не удалось получить время: ${message}` };
    }
  },
};

export default getTime;