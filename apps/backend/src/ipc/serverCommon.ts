import { isObject, validateOrThrow } from "./common";

export { isObject, validateOrThrow };

export function send(msg: unknown) {
  if (typeof process.send === "function") {
    process.send(msg);
  }
}

export function replyOk(id: string, result: unknown) {
  send({ id, type: "res", ok: true, result });
}

export function replyErr(id: string, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  send({
    id,
    type: "res",
    ok: false,
    error: {
      message: e.message,
      ...(typeof e.stack === "string" ? { stack: e.stack } : {}),
    },
  });
}
