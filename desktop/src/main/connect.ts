// Agents on the connect screen (DESIGN §3.1, §3.3): found or not, the sign-in
// check (a yes or no; Codemm never touches credentials), the tested-version
// warning and the recommended minimum model.
import { NO_AGENT, SIGNED_OUT, type Agent, type AgentId } from '../shared/api';
import models from '../shared/models.json';
import { AGENT_CLIS, isTested } from './agent/agents';
import type { Executable } from './agent/bridge';
import type { desktopState } from './state';

export interface Lookup {
  find(bin: string): Executable | null;
  signedIn(id: AgentId, exe: Executable): Promise<boolean>;
  version(id: AgentId, exe: Executable): Promise<string | null>;
}

const INFO: Record<AgentId, { name: string; installUrl: string; experimental: boolean }> = {
  claude: { name: 'Claude Code', installUrl: 'https://code.claude.com/docs/en/setup', experimental: false },
  codex: { name: 'Codex', installUrl: 'https://developers.openai.com/codex/cli', experimental: false },
  cursor: { name: 'Cursor', installUrl: 'https://cursor.com/docs/cli/installation', experimental: true },
};
const IDS: AgentId[] = ['claude', 'codex', 'cursor'];

export function connector(lookup: Lookup, state: ReturnType<typeof desktopState>) {
  /** The last sign-in answer per agent this session. */
  const signedIn = new Map<AgentId, boolean>();
  const versions = new Map<AgentId, string | null>();

  async function view(id: AgentId): Promise<Agent> {
    const exe = lookup.find(AGENT_CLIS[id].bin);
    let agentState: Agent['state'] = 'missing';
    if (exe) {
      if (!versions.has(id)) versions.set(id, await lookup.version(id, exe));
      const known = signedIn.get(id);
      agentState = known === false ? 'signed-out' : state.read().agent === id && known ? 'connected' : 'not-connected';
    }
    const version = versions.get(id);
    return { id, ...INFO[id], state: agentState, recommended: models[id], untested: Boolean(exe && version && !isTested(id, version)) };
  }

  return {
    agents: () => Promise.all(IDS.map(view)),

    async connect(id: AgentId): Promise<Agent> {
      const exe = lookup.find(AGENT_CLIS[id].bin);
      if (exe) {
        const ok = await lookup.signedIn(id, exe);
        signedIn.set(id, ok);
        if (ok) state.update((s) => ({ ...s, agent: id }));
      }
      return view(id);
    },

    /** The agent jobs run with. Rejects with NO_AGENT or SIGNED_OUT, which open the connect screen. */
    async chosen(): Promise<{ id: AgentId; exe: Executable }> {
      const id = state.read().agent;
      const exe = id && lookup.find(AGENT_CLIS[id].bin);
      if (!id || !exe) throw new Error(NO_AGENT);
      // The status command runs once a session, and again only after a job fails (jobs.ts).
      const ok = signedIn.get(id) ?? (await this.recheck(id, exe));
      if (!ok) throw new Error(SIGNED_OUT);
      return { id, exe };
    },

    /** Runs the sign-in check again, as after a job fails for an unknown reason. */
    async recheck(id: AgentId, exe: Executable): Promise<boolean> {
      const ok = await lookup.signedIn(id, exe);
      signedIn.set(id, ok);
      return ok;
    },
  };
}
