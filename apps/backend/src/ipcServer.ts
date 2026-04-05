import crypto from "crypto";
import { initializeDatabase } from "./database";
import { getResolvedLlmSnapshot, withResolvedLlmSnapshot } from "./infra/llm/executionContext";
import type { ResolvedLlmRoutePlan, ResolvedLlmSnapshot } from "./infra/llm/types";
import { z } from "zod";
import { createActivityHandlers } from "./ipc/activities";
import { isObject, replyErr, replyOk, send, validateOrThrow } from "./ipc/serverCommon";
import { createJudgeHandlers } from "./ipc/judge";
import { createThreadHandlers, shutdownThreadHandlers } from "./ipc/threads";
import type { JsonObject, RpcHandlerDef } from "./ipc/types";

type RpcRequest = {
  id: string;
  type: "req";
  method: string;
  params?: JsonObject;
  context?: {
    llmSnapshot?: ResolvedLlmSnapshot | null;
    llmRoutePlan?: ResolvedLlmRoutePlan | null;
  };
};

type RpcResponse =
  | { id: string; type: "res"; ok: true; result: unknown }
  | { id: string; type: "res"; ok: false; error: { message: string; stack?: string } };

type RpcEvent = {
  type: "event";
  topic: string;
  payload: unknown;
};
const rpcHandlers: Record<string, RpcHandlerDef> = {
  "engine.ping": {
    handler: async () => ({ ok: true }),
  },
  ...createThreadHandlers({
    sendEvent: (topic, payload) => send({ type: "event", topic, payload }),
  }),
  ...createActivityHandlers(),
  ...createJudgeHandlers(),
};

async function handle(method: string, paramsRaw: unknown, contextRaw?: unknown): Promise<unknown> {
  const def = rpcHandlers[method];
  if (!def) {
    throw new Error(`Unknown method: ${method}`);
  }
  const validated = def.schema ? validateOrThrow(def.schema, paramsRaw) : paramsRaw;
  const context = isObject(contextRaw) ? contextRaw : {};
  const llmContext =
    isObject((context as any).llmRoutePlan) && typeof (context as any).llmRoutePlan.provider === "string"
      ? ((context as any).llmRoutePlan as ResolvedLlmRoutePlan)
      : isObject((context as any).llmSnapshot) && typeof (context as any).llmSnapshot.provider === "string"
        ? ((context as any).llmSnapshot as ResolvedLlmSnapshot)
        : null;
  return withResolvedLlmSnapshot(llmContext, () => def.handler(validated));
}

function onMessage(raw: unknown) {
  if (!isObject(raw)) return;
  const msg = raw as Partial<RpcRequest>;
  if (msg.type !== "req") return;
  if (typeof msg.id !== "string" || !msg.id) return;
  if (typeof msg.method !== "string" || !msg.method) return;

  Promise.resolve()
    .then(() => handle(msg.method!, msg.params, msg.context))
    .then((result) => replyOk(msg.id!, result))
    .catch((err) => replyErr(msg.id!, err));
}

function shutdown() {
  shutdownThreadHandlers();
}

initializeDatabase();

process.on("message", onMessage);
process.on("disconnect", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("exit", shutdown);
