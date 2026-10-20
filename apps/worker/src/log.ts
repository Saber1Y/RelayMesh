// One JSON object per line so logs can be grepped and shipped as-is. bigint values become strings.

type Level = "info" | "warn" | "error";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function write(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }, (_k, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message };
    return v;
  });
  (level === "error" ? console.error : console.log)(line);
}

export const jsonLogger: Logger = {
  info: (m, f) => write("info", m, f),
  warn: (m, f) => write("warn", m, f),
  error: (m, f) => write("error", m, f),
};
