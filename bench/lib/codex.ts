/** Codex: `codex exec --json`. */
import { type AgentRun, type HostAdapter, type ToolUse, jsonLines } from "./agent.ts";

const toml = (v: unknown) => JSON.stringify(v);

/** Owner-level features that would add tools or memory unrelated to Codemm. */
const DISABLED = ["apps", "plugins", "memories", "browser_use", "computer_use", "image_generation"];

function toolUses(item: any): ToolUse[] {
  switch (item.type) {
    case "mcp_tool_call": {
      const name = item.server === "codemm" ? `codemm.${item.tool}` : `${item.server}.${item.tool}`;
      const text = Array.isArray(item.result?.content) ? item.result.content.map((c: any) => c?.text ?? "").join("\n") : String(item.error?.message ?? item.error ?? "");
      return [{ kind: item.server === "codemm" ? "codemm" : "other", name, input: JSON.stringify(item.arguments ?? {}).slice(0, 2000), sub: false, isError: item.status === "failed" || Boolean(item.error), result: text.slice(0, 20_000) }];
    }
    case "command_execution":
      return [{ kind: "shell", name: "shell", input: String(item.command ?? ""), sub: false, isError: item.exit_code !== 0, result: String(item.aggregated_output ?? "").slice(0, 20_000) }];
    case "file_change":
      return (item.changes ?? []).map((c: any) => ({ kind: "edit", name: `file_change:${c.kind ?? "update"}`, input: String(c.path ?? ""), sub: false, isError: item.status === "failed" }));
    case "collab_tool_call": {
      // A subagent's reply comes back to the tutor in agents_states[*].message.
      const replies = Object.values(item.agents_states ?? {}).map((a: any) => a?.message).filter((m): m is string => typeof m === "string");
      return [{ kind: "agent", name: item.tool ?? item.type, input: String(item.prompt ?? ""), sub: false, result: replies.join("\n") }];
    }
    default:
      return [];
  }
}

export function parseCodex(stdout: string): AgentRun {
  const tools: ToolUse[] = [];
  const said: string[] = [];
  const run: AgentRun = { ok: false, finalText: "", exposedText: "", tools, denials: 0 };
  let turns = 0;
  const tokens = { input: 0, output: 0 };
  for (const e of jsonLines(stdout)) {
    if (e.type === "item.completed" && e.item) {
      if (e.item.type === "agent_message") {
        said.push(e.item.text ?? "");
        run.finalText = e.item.text ?? "";
      } else {
        const uses = toolUses(e.item);
        tools.push(...uses);
        for (const u of uses) if (u.kind === "agent" && u.result) said.push(u.result);
      }
    } else if (e.type === "turn.completed") {
      turns += 1;
      run.ok = true;
      tokens.input += e.usage?.input_tokens ?? 0;
      tokens.output += (e.usage?.output_tokens ?? 0) + (e.usage?.reasoning_output_tokens ?? 0);
    } else if (e.type === "turn.failed" || e.type === "error") {
      run.ok = false;
      run.error = String(e.error?.message ?? e.message ?? e.type);
    }
  }
  run.turns = turns;
  run.tokens = tokens;
  run.exposedText = said.join("\n");
  if (!run.ok && !run.error) run.error = "no turn.completed event";
  return run;
}

export const codex: HostAdapter = {
  command({ model, prompt, ws, mcp }) {
    return {
      command: "codex",
      args: [
        // Not --ephemeral: subagents resume through the persisted thread. run.ts deletes the session files.
        "exec", "--json", "--skip-git-repo-check",
        // The owner's user config (other MCP servers, memories) stays out; auth still comes from CODEX_HOME.
        "--ignore-user-config",
        ...DISABLED.flatMap((f) => ["--disable", f]),
        "-m", model,
        // Writable so a tutor that edits exercises/ shows up; Codex has no practice hook.
        "-s", "workspace-write",
        "-C", ws,
        // Codex loads .codex/config.toml only for trusted projects; pass the same server block instead of
        // editing the owner's trust list. The bench approves Codemm's tools, as README.md describes.
        "-c", `mcp_servers.codemm.command=${toml(mcp.command)}`,
        "-c", `mcp_servers.codemm.args=${toml(mcp.args)}`,
        "-c", `mcp_servers.codemm.default_tools_approval_mode="approve"`,
        "-c", "mcp_servers.codemm.tool_timeout_sec=900",
        prompt,
      ],
    };
  },
  parse: parseCodex,
};
