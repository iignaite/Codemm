import crypto from "crypto";
import { z } from "zod";
import type { JsonObject } from "./types";
import { logStructured } from "../infra/observability/logger";

export function isObject(x: unknown): x is JsonObject {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

export function getString(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

export function getNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function requireParams(params: unknown): JsonObject {
  if (!isObject(params)) throw new Error("Invalid params.");
  return params;
}

export function defaultAssistantPrompt(): string {
  return "How can I help you today?\n\nTell me what you want to learn, and optionally the language (java/python/cpp/sql) and how many problems (1–7).";
}

export function makeSubId(): string {
  return crypto.randomUUID();
}

export function safeJsonStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function validateOrThrow(schema: z.ZodTypeAny, paramsRaw: unknown): unknown {
  const res = schema.safeParse(paramsRaw);
  if (!res.success) {
    const msg = res.error.issues?.[0]?.message || "Invalid params.";
    throw new ValidationError(msg);
  }
  return res.data;
}

/**
 * Run a side effect that must not break the caller (e.g. run-log persistence
 * during a live stream) but whose failure is a bug worth seeing in logs.
 */
export function bestEffort(event: string, context: Record<string, unknown>, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logStructured("warn", event, { ...context, message: err instanceof Error ? err.message : String(err) });
  }
}
