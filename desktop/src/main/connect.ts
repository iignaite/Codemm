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
  /** Null when the check couldn't answer (a timeout, or offline): that isn't signed out. */
  signedIn(id: AgentId, exe: Executable): Promise<boolean | null>;
  version(id: AgentId, exe: Executable): Promise<string | null>;
}

/** Each agent as the connect screen shows it; the mock uses the same (mock.ts). */
export const AGENT_INFO: Record<AgentId, { name: string; installUrl: string; experimental: boolean }> = {
  claude: { name: 'Claude Code', installUrl: 'https://code.claude.com/docs/en/setup', experimental: false },
  codex: { name: 'Codex', installUrl: 'https://developers.openai.com/codex/cli', experimental: false },
  cursor: { name: 'Cursor', installUrl: 'https://cursor.com/docs/cli/installation', experimental: true },
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

/** A look checks an agent's sign-in again only this long after its last check ended: each check starts the agent. */
export const RECHECK_MS = 5000;

export function connector(lookup: Lookup, state: ReturnType<typeof desktopState>, setup: AgentSetup = NO_SETUP) {
  /** The last sign-in answer per agent this session. */
  const signedIn = new Map<AgentId, boolean>();
  /** Keeps a real answer; one that couldn't tell is asked again on the next look. */
  const remember = (id: AgentId, ok: boolean | null) => ok !== null && signedIn.set(id, ok);
  const versions = new Map<AgentId, string | null>();
  /** The agent the learner last tried to connect: once it's signed in, it connects. */
  let tried: AgentId | undefined;
  /** When each agent's last sign-in check ended, and the check still running. */
  const checkedAt = new Map<AgentId, number>();
  const checking = new Map<AgentId, Promise<boolean | null>>();
  /** Whether a look may check the agent's sign-in again: Connect, Welcome and Setup look every few seconds. */
  const due = (id: AgentId) => !checking.has(id) && Date.now() - (checkedAt.get(id) ?? -Infinity) >= RECHECK_MS;

  /** The agent's own status command, shared while it runs; every check counts toward the next look's wait. */
  function ask(id: AgentId, exe: Executable): Promise<boolean | null> {
    let check = checking.get(id);
    if (!check) {
      check = lookup.signedIn(id, exe).finally(() => {
        checking.delete(id);
        checkedAt.set(id, Date.now());
      });
      checking.set(id, check);
    }
    return check;
  }

  /**
   * The agent's CLI, unless Codemm has started installing it and no install is done yet. A failed attempt may have left
   * a binary nothing checked, and a later failure (offline, say) must not clear an earlier rejection, so nothing of it
   * runs this session, not even --version, and Try again installs again. An agent the learner installed themselves is
   * theirs to trust, as in a terminal; so is one found after a relaunch.
   */
  function usable(id: AgentId): Executable | null {
    const install = setup.status(id);
    return install && install.phase !== 'done' ? null : lookup.find(AGENT_CLIS[id].bin);
  }

  /** Thrown when Codemm starts installing an agent while its view is being looked at: the view starts over. */
  const STARTED_INSTALL = Symbol('started install');

  /** The agent's sign-in check, run only if the agent may run right now: a reinstall may have started meanwhile. */
  async function checkSignIn(id: AgentId) {
    const exe = usable(id);
    if (!exe) throw STARTED_INSTALL;
    return ask(id, exe);
  }

  async function view(id: AgentId): Promise<Agent> {
    try {
      return await look(id);
    } catch (e) {
      if (e === STARTED_INSTALL) return view(id);
      throw e;
    }
  }

  async function look(id: AgentId): Promise<Agent> {
    const exe = usable(id);
    let agentState: Agent['state'] = 'missing';
    const install = setup.status(id);
    if (exe) {
      if (!versions.has(id)) versions.set(id, await lookup.version(id, exe));
      // Just installed by Codemm: check its sign-in, and connect it if it's signed in and still the one tried last.
      if (install?.phase === 'done' && !signedIn.has(id) && due(id)) {
        const ok = await checkSignIn(id);
        remember(id, ok);
        if (ok && tried === id) state.update((s) => ({ ...s, agent: id }));
      }
      const chosen = state.read().agent === id;
      // The agent chosen before: check its sign-in once this launch, so a relaunch doesn't ask to connect again.
      if (chosen && !signedIn.has(id) && due(id)) remember(id, await checkSignIn(id));
      // Signed out: check again on a later look, so signing in from a terminal or the browser shows within seconds.
      if (signedIn.get(id) === false && due(id) && (await checkSignIn(id))) {
        signedIn.set(id, true);
        if (tried === id) state.update((s) => ({ ...s, agent: id }));
      }
      const known = signedIn.get(id);
      // The chosen agent is connected unless its own check said no (a check that can't tell asks again next look).
      agentState = known === false ? 'signed-out' : state.read().agent === id ? 'connected' : 'not-connected';
    }
    const version = versions.get(id);
    const model = modelFor(id, state.read().models?.[id]);
    return {
      id, ...AGENT_INFO[id], state: agentState, models: modelChoices(id), model, untested: Boolean(exe && version && !isTested(id, version)),
      canInstall: setup.canInstall(id), ...(install ? { install } : {}),
    };
  }

  return {
    async agents(): Promise<Agent[]> {
      const agents = await Promise.all(IDS.map(view));
      // One agent is connected: one that signed in during this look may have become the choice after another's view.
      const chosen = state.read().agent;
      return agents.map((a) => (a.state === 'connected' && a.id !== chosen ? { ...a, state: 'not-connected' } : a));
    },

    /** Starts installing a missing agent; follow it with agents(). */
    async install(id: AgentId): Promise<void> {
      if (setup.canInstall(id) && !usable(id)) {
        // A fresh install gets a fresh sign-in check, and connects once signed in unless the learner tries another.
        signedIn.delete(id);
        tried = id;
        setup.install(id);
      }
    },

    /** Starts the agent's own login. Signing in shows on the next look, when the learner comes back (agents()). */
    async signIn(id: AgentId): Promise<void> {
      const exe = usable(id);
      if (!exe) return;
      tried = id;
      // Checked again on the next look, unless it's known to be signed in already.
      if (signedIn.get(id) !== true) signedIn.set(id, false);
      await setup.signIn(id, exe);
    },

    async connect(id: AgentId): Promise<Agent> {
      tried = id;
      const exe = usable(id);
      if (exe) {
        const ok = await ask(id, exe);
        remember(id, ok);
        // Only the agent's own no is signed out: a check that can't tell connects, and a job says the rest.
        if (ok !== false) state.update((s) => ({ ...s, agent: id }));
      }
      return view(id);
    },

    /** Saves the model for an agent's jobs; only one of its bench-tested models. */
    async chooseModel(id: AgentId, model: string): Promise<Agent> {
      if (!modelChoices(id).some((m) => m.id === model)) throw new Error(`${model} isn't a tested model for ${AGENT_INFO[id].name}.`);
      state.update((s) => ({ ...s, models: { ...s.models, [id]: model } }));
      return view(id);
    },

    /** Whether anything of the agent may run now: false once Codemm has started installing it, until that is done. */
    usable: (id: AgentId) => usable(id) !== null,

    /** The agent jobs run with, and its model. Rejects with NO_AGENT or SIGNED_OUT, which open the connect screen. */
    async chosen(): Promise<{ id: AgentId; exe: Executable; model?: string }> {
      const id = state.read().agent;
      const exe = id && usable(id);
      if (!id || !exe) throw new Error(NO_AGENT);
      // The status command runs once a session, and again only after a job fails (jobs.ts).
      const ok = signedIn.get(id) ?? (await this.recheck(id));
      // Signed out only when the agent says so; a check that can't tell lets the job run and say the rest.
      if (ok === false) throw new Error(SIGNED_OUT);
      return { id, exe, model: modelFor(id, state.read().models?.[id]) ?? undefined };
    },

    /**
     * Runs the sign-in check again, as after a job fails for an unknown reason. While Codemm is installing the agent
     * again, nothing of it runs, and the job ends as signed out. Null: the check couldn't answer.
     */
    async recheck(id: AgentId): Promise<boolean | null> {
      const exe = usable(id);
      if (!exe) return false;
      const ok = await ask(id, exe);
      remember(id, ok);
      return ok;
    },
  };
}
