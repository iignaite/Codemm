// Agents on the connect screen (DESIGN §3.1, §3.3): found or not, the sign-in
// check (a yes or no; Codemm never touches credentials), the tested-version
// warning and the recommended minimum model.
import { NO_AGENT, SIGNED_OUT, type Agent, type AgentId, type AgentInstall } from '../shared/api';
import { modelChoices, modelFor } from '../shared/models';
import { AGENT_CLIS, isTested } from './agent/agents';
import type { Executable } from './agent/bridge';
import type { desktopState } from './state';

export interface Lookup {
  find(bin: string): Executable | null;
  signedIn(id: AgentId, exe: Executable): Promise<boolean>;
  version(id: AgentId, exe: Executable): Promise<string | null>;
}

// signIn: each CLI's own sign-in command, from its --help.
const INFO: Record<AgentId, { name: string; installUrl: string; signIn: string; experimental: boolean }> = {
  claude: { name: 'Claude Code', installUrl: 'https://code.claude.com/docs/en/setup', signIn: 'claude auth login', experimental: false },
  codex: { name: 'Codex', installUrl: 'https://developers.openai.com/codex/cli', signIn: 'codex login', experimental: false },
  cursor: { name: 'Cursor', installUrl: 'https://cursor.com/docs/cli/installation', signIn: 'cursor-agent login', experimental: true },
};
const IDS: AgentId[] = ['claude', 'codex', 'cursor'];

/** Installing an agent for the learner (agentInstall.ts), and starting its own sign-in. */
export interface AgentSetup {
  canInstall(id: AgentId): boolean;
  install(id: AgentId): void;
  status(id: AgentId): AgentInstall | undefined;
  /** Starts the agent's own login where the learner sees it. Codemm never reads, stores or types credentials. */
  signIn(id: AgentId, exe: Executable): Promise<void>;
}

const NO_SETUP: AgentSetup = { canInstall: () => false, install: () => undefined, status: () => undefined, signIn: async () => undefined };

export function connector(lookup: Lookup, state: ReturnType<typeof desktopState>, setup: AgentSetup = NO_SETUP) {
  /** The last sign-in answer per agent this session. */
  const signedIn = new Map<AgentId, boolean>();
  const versions = new Map<AgentId, string | null>();
  /** The agent the learner last tried to connect: once it's signed in, it connects. */
  let tried: AgentId | undefined;

  async function view(id: AgentId): Promise<Agent> {
    const exe = lookup.find(AGENT_CLIS[id].bin);
    let agentState: Agent['state'] = 'missing';
    const install = setup.status(id);
    if (exe) {
      if (!versions.has(id)) versions.set(id, await lookup.version(id, exe));
      // Just installed by Codemm: check its sign-in once, and connect it if it's signed in.
      if (install?.phase === 'done' && !signedIn.has(id)) {
        tried = id;
        const ok = await lookup.signedIn(id, exe);
        signedIn.set(id, ok);
        if (ok) state.update((s) => ({ ...s, agent: id }));
      }
      const chosen = state.read().agent === id;
      // The agent chosen before: check its sign-in once this launch, so a relaunch doesn't ask to connect again.
      if (chosen && !signedIn.has(id)) signedIn.set(id, await lookup.signedIn(id, exe));
      // Signed out: check again on every look, so signing in from a terminal shows when the learner comes back.
      if (signedIn.get(id) === false && (await lookup.signedIn(id, exe))) {
        signedIn.set(id, true);
        if (tried === id) state.update((s) => ({ ...s, agent: id }));
      }
      const known = signedIn.get(id);
      agentState = known === false ? 'signed-out' : state.read().agent === id && known ? 'connected' : 'not-connected';
    }
    const version = versions.get(id);
    const model = modelFor(id, state.read().models?.[id]);
    return {
      id, ...INFO[id], state: agentState, models: modelChoices(id), model, untested: Boolean(exe && version && !isTested(id, version)),
      canInstall: setup.canInstall(id), ...(install ? { install } : {}),
    };
  }

  return {
    agents: () => Promise.all(IDS.map(view)),

    /** Starts installing a missing agent; follow it with agents(). */
    async install(id: AgentId): Promise<void> {
      if (setup.canInstall(id) && !lookup.find(AGENT_CLIS[id].bin)) {
        // A fresh install gets a fresh sign-in check.
        signedIn.delete(id);
        setup.install(id);
      }
    },

    /** Starts the agent's own login. Signing in shows on the next look, when the learner comes back (agents()). */
    async signIn(id: AgentId): Promise<void> {
      const exe = lookup.find(AGENT_CLIS[id].bin);
      if (!exe) return;
      tried = id;
      // Checked again on the next look, unless it's known to be signed in already.
      if (signedIn.get(id) !== true) signedIn.set(id, false);
      await setup.signIn(id, exe);
    },

    async connect(id: AgentId): Promise<Agent> {
      tried = id;
      const exe = lookup.find(AGENT_CLIS[id].bin);
      if (exe) {
        const ok = await lookup.signedIn(id, exe);
        signedIn.set(id, ok);
        if (ok) state.update((s) => ({ ...s, agent: id }));
      }
      return view(id);
    },

    /** Saves the model for an agent's jobs; only one of its bench-tested models. */
    async chooseModel(id: AgentId, model: string): Promise<Agent> {
      if (!modelChoices(id).some((m) => m.id === model)) throw new Error(`${model} isn't a tested model for ${INFO[id].name}.`);
      state.update((s) => ({ ...s, models: { ...s.models, [id]: model } }));
      return view(id);
    },

    /** The agent jobs run with, and its model. Rejects with NO_AGENT or SIGNED_OUT, which open the connect screen. */
    async chosen(): Promise<{ id: AgentId; exe: Executable; model?: string }> {
      const id = state.read().agent;
      const exe = id && lookup.find(AGENT_CLIS[id].bin);
      if (!id || !exe) throw new Error(NO_AGENT);
      // The status command runs once a session, and again only after a job fails (jobs.ts).
      const ok = signedIn.get(id) ?? (await this.recheck(id, exe));
      if (!ok) throw new Error(SIGNED_OUT);
      return { id, exe, model: modelFor(id, state.read().models?.[id]) ?? undefined };
    },

    /** Runs the sign-in check again, as after a job fails for an unknown reason. */
    async recheck(id: AgentId, exe: Executable): Promise<boolean> {
      const ok = await lookup.signedIn(id, exe);
      signedIn.set(id, ok);
      return ok;
    },
  };
}
