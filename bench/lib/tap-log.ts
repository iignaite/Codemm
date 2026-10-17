/** Parsing for the MCP tap's log: which Codemm tools were called, with what, and what came back. */

export type TapRecord =
  | { kind: "call"; id: string | number; name: string; args: Record<string, unknown> }
  | { kind: "result"; id: string | number; isError: boolean; text: string };

export type TapCall = { name: string; args: Record<string, unknown>; done: boolean; isError: boolean; text: string };

/** The records worth logging from one JSON-RPC line ("in" = host to server, "out" = server to host). */
export function tapRecords(line: string, dir: "in" | "out"): TapRecord[] {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof msg !== "object" || msg === null || msg.id === undefined) return [];
  if (dir === "in" && msg.method === "tools/call") {
    return [{ kind: "call", id: msg.id, name: String(msg.params?.name ?? ""), args: msg.params?.arguments ?? {} }];
  }
  if (dir === "out" && (msg.result !== undefined || msg.error !== undefined)) {
    const content = Array.isArray(msg.result?.content) ? msg.result.content : [];
    const text = msg.error ? String(msg.error.message ?? "") : content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
    return [{ kind: "result", id: msg.id, isError: Boolean(msg.error) || msg.result?.isError === true, text }];
  }
  return [];
}

/** Pairs calls with results per server process, in call order. Calls with no result (killed run) have done=false. */
export function parseTapLog(text: string): TapCall[] {
  const calls: TapCall[] = [];
  const pending = new Map<string, TapCall>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const key = `${r.pid}:${r.id}`;
    if (r.kind === "call") {
      const call: TapCall = { name: r.name, args: r.args ?? {}, done: false, isError: false, text: "" };
      calls.push(call);
      pending.set(key, call);
    } else if (r.kind === "result" && pending.has(key)) {
      const call = pending.get(key)!;
      pending.delete(key);
      Object.assign(call, { done: true, isError: r.isError, text: r.text });
    }
  }
  return calls;
}
