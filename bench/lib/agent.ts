/** A host-neutral view of one headless agent run, parsed from the host's JSON output. */

/** Tool kinds the metrics care about; anything else keeps its host name. */
export type ToolKind = "shell" | "edit" | "read" | "agent" | "codemm" | "other";

export type ToolUse = {
  kind: ToolKind;
  /** Host tool name, or `codemm.<tool>` for Codemm's MCP tools. */
  name: string;
  /** The command, path or prompt the tool was given. */
  input: string;
  /** True when the call ran inside a subagent. */
  sub: boolean;
  isError?: boolean;
  result?: string;
};

export type AgentRun = {
  /** The host finished with a final answer. */
  ok: boolean;
  finalText: string;
  /** Everything the tutor showed the learner, plus what subagents returned to the tutor. */
  exposedText: string;
  turns?: number;
  /** Model IDs the host reported using (aliases like `haiku` resolve to these). */
  models?: string[];
  costUsd?: number;
  tokens?: { input: number; output: number };
  tools: ToolUse[];
  /** Tool calls the host's permission system refused. */
  denials: number;
  /** The host reported that Codemm's MCP server failed to start: an infrastructure failure, not the model's. */
  serverFailed?: boolean;
  error?: string;
};

/** A command line, plus files the runner writes before starting it. */
export type HostRun = { command: string; args: string[]; files?: Record<string, string> };

export type HostAdapter = {
  /** Command line for one headless prompt. `mcp` is the tapped Codemm server launcher. */
  command(opts: { model: string; prompt: string; ws: string; mcp: HostRun; scratch: string }): HostRun;
  parse(stdout: string): AgentRun;
};

export const emptyRun = (error: string): AgentRun => ({ ok: false, finalText: "", exposedText: "", tools: [], denials: 0, error });

/** Splits JSONL, skipping lines that aren't JSON objects (hosts print banners and warnings). */
export function jsonLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // a torn last line from a killed run
    }
  }
  return out;
}
