/** Claude Code: `claude -p` with stream-json output. */
import { join } from "node:path";
import { type AgentRun, type HostAdapter, type ToolKind, type ToolUse, jsonLines } from "./agent.ts";

const KINDS: Record<string, ToolKind> = {
  Bash: "shell",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Read: "read",
  Grep: "read",
  Glob: "read",
  LS: "read",
  Task: "agent",
  Agent: "agent",
};

function toolUse(block: any, sub: boolean): ToolUse {
  const name: string = block.name ?? "";
  const input = block.input ?? {};
  if (name.startsWith("mcp__codemm__")) return { kind: "codemm", name: `codemm.${name.slice("mcp__codemm__".length)}`, input: JSON.stringify(input).slice(0, 2000), sub };
  const kind = KINDS[name] ?? "other";
  const text = input.command ?? input.file_path ?? input.notebook_path ?? input.path ?? input.pattern ?? input.prompt ?? JSON.stringify(input);
  return { kind, name, input: String(text), sub };
}

/** How Claude Code words a tool call it refused for lack of permission. */
const DENIED = /requires approval|haven't granted|permission to use/i;

const resultText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "";

export function parseClaude(stdout: string): AgentRun {
  const tools: ToolUse[] = [];
  const byId = new Map<string, ToolUse>();
  const said: string[] = [];
  let denied = 0;
  const run: AgentRun = { ok: false, finalText: "", exposedText: "", tools, denials: 0 };
  for (const e of jsonLines(stdout)) {
    const sub = Boolean(e.parent_tool_use_id);
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === "system" && e.subtype === "init") {
      run.serverFailed = (e.mcp_servers ?? []).some((s: any) => s.name === "codemm" && s.status === "failed");
    } else if (e.type === "assistant") {
      for (const block of content) {
        if (block.type === "text" && !sub) said.push(block.text);
        if (block.type === "tool_use") {
          const use = toolUse(block, sub);
          tools.push(use);
          byId.set(block.id, use);
        }
      }
    } else if (e.type === "user") {
      for (const block of content) {
        const use = block.type === "tool_result" ? byId.get(block.tool_use_id) : undefined;
        if (!use) continue;
        use.isError = block.is_error === true;
        use.result = resultText(block.content).slice(0, 20_000);
        if (use.isError && DENIED.test(use.result)) denied += 1;
        if (use.kind === "agent" && !use.sub) said.push(use.result);
      }
    } else if (e.type === "result") {
      run.ok = e.subtype === "success" && e.is_error !== true;
      run.finalText = typeof e.result === "string" ? e.result : "";
      run.turns = e.num_turns;
      run.costUsd = e.total_cost_usd;
      run.models = Object.keys(e.modelUsage ?? {});
      run.denials = Array.isArray(e.permission_denials) ? e.permission_denials.length : 0;
      if (e.usage) run.tokens = { input: (e.usage.input_tokens ?? 0) + (e.usage.cache_read_input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0), output: e.usage.output_tokens ?? 0 };
      if (!run.ok) run.error = run.finalText || e.subtype;
    }
  }
  // permission_denials misses refusals inside compound commands and subagents; count them from the results too.
  run.denials = Math.max(run.denials, denied);
  // The result event repeats the last thing the tutor said.
  run.exposedText = (said.at(-1) === run.finalText ? said : [...said, run.finalText]).join("\n");
  if (!run.ok && !run.error) run.error = "no result event";
  return run;
}

export const claude: HostAdapter = {
  command({ model, prompt, mcp, scratch }) {
    const config = join(scratch, "claude-mcp.json");
    return {
      command: "claude",
      args: [
        "-p", prompt,
        "--model", model,
        "--output-format", "stream-json",
        "--verbose",
        // Edits are allowed so Codemm's practice hook, not the permission system, is what protects exercises/.
        "--permission-mode", "acceptEdits",
        "--allowedTools", "mcp__codemm",
        // Only the tapped Codemm server and the project's settings (its hook and subagent); none of the owner's.
        "--strict-mcp-config", "--mcp-config", config,
        "--setting-sources", "project,local",
        // Sessions persist (as for a learner) because subagent resumption needs the transcript; run.ts deletes them.
      ],
      files: { [config]: `${JSON.stringify({ mcpServers: { codemm: { type: "stdio", command: mcp.command, args: mcp.args } } }, null, 2)}\n` },
    };
  },
  parse: parseClaude,
};
