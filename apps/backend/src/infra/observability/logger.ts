import { getTraceContext } from "./tracer";

export type LogLevel = "debug" | "info" | "warn" | "error";

function shouldTrace(): boolean {
  return process.env.CODEMM_TRACE === "1";
}

function shouldTraceFull(): boolean {
  return process.env.CODEMM_TRACE_FULL === "1";
}

export function isTraceEnabled(): boolean {
  return shouldTrace();
}

export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…(truncated, len=${text.length})`;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "sk-[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, "Bearer [REDACTED]")
    .replace(/(\"apiKey\"\s*:\s*\")([^\"]+)(\")/gi, `$1[REDACTED]$3`)
    .replace(/(\"apiKeyEncB64\"\s*:\s*\")([^\"]+)(\")/gi, `$1[REDACTED]$3`);
}

export function logStructured(level: LogLevel, event: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  const ctx = getTraceContext();
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(ctx ?? {}),
    ...data,
  };
  const line = redactSecrets(JSON.stringify(payload));
  if (level === "error" || level === "warn") {
    console[level](`[CODEMM_TRACE] ${line}`);
  } else if (shouldTrace()) {
    console.log(`[CODEMM_TRACE] ${line}`);
  }
  return payload;
}

export function logText(event: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const maxLen = shouldTraceFull() ? 20_000 : 2_000;
  return logStructured("debug", event, { text: truncateText(text, maxLen), ...extra });
}

export function createLogger(component: string) {
  return {
    debug(event: string, data: Record<string, unknown> = {}) {
      return logStructured("debug", `${component}.${event}`, data);
    },
    info(event: string, data: Record<string, unknown> = {}) {
      return logStructured("info", `${component}.${event}`, data);
    },
    warn(event: string, data: Record<string, unknown> = {}) {
      return logStructured("warn", `${component}.${event}`, data);
    },
    error(event: string, data: Record<string, unknown> = {}) {
      return logStructured("error", `${component}.${event}`, data);
    },
  };
}
