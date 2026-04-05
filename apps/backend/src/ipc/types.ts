import type { ZodTypeAny } from "zod";

export type JsonObject = Record<string, unknown>;

export type RpcHandler = (paramsRaw: unknown) => Promise<unknown>;

export type RpcHandlerDef = {
  schema?: ZodTypeAny;
  handler: RpcHandler;
};
