import { useEffect, useRef, useState } from 'react';
import type { Agent, AgentId, AgentInstall } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter, type Route } from '../../app/router';
import { Failed, Stale } from '../../app/Problems';
import { timing, useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { StageFill } from '../../ui/StageFill';
import { ExternalLink } from '../../ui/ExternalLink';

/** The only screen that names agents. Each one that can't run yet shows its next step. */
export function Connect({ then = { to: 'goal' } }: { then?: Route }) {
  const api = useApi();
  const { go, fail } = useRouter();
  // Looks again every few seconds and when the window regains focus, so an agent installed, removed or signed in
  // elsewhere shows up. An install is followed until it ends.
  const { data, error, stale, reload } = useLoad(() => api.agents(), [], { settled: (as) => !as.some((a) => running(a.install)), onFocus: true, idle: timing.agentsMs });
  const [agents, setAgents] = useState<Agent[]>();
  useEffect(() => setAgents(undefined), [data]);
  const [busy, setBusy] = useState<string>();
  // The agent the learner is installing or signing in: once it's connected, Codemm moves on by itself.
  const [following, setFollowing] = useState<AgentId>();
  const list = agents ?? data;
  // The only supported agent installed is the learner's choice already: its sign-in check runs at once, once, on the
  // first look that finds one (installed in a terminal meanwhile, say). Never while another agent is connected.
  const picked = useRef(false);
  useEffect(() => {
    if (!data || picked.current) return;
    const installed = data.filter((a) => a.state !== 'missing' && !a.experimental);
    if (installed.length === 0) return;
    picked.current = true;
    if (installed.length === 1 && installed[0].state === 'not-connected' && !data.some((a) => a.state === 'connected')) void connect(installed[0].id);
  }, [data]);
  const next: Route = { to: 'computer', then, fromConnect: true };
  useEffect(() => {
    if (following && list?.find((a) => a.id === following)?.state === 'connected') go(next);
  }, [following, list]);
  if (error) return <Failed error={error} retry={reload} />;
  if (!list) return null;

  /** Shows an agent's new state at once, then looks again: a look already under way began before the change. */
  function replace(agent: Agent) {
    // One agent is connected at a time: connecting another switches to it.
    const before = (a: Agent) => (agent.state === 'connected' && a.state === 'connected' ? { ...a, state: 'not-connected' as const } : a);
    setAgents((current) => (current ?? data)?.map((a) => (a.id === agent.id ? agent : before(a))));
    reload();
  }

  async function choose(id: AgentId, model: string) {
    try {
      replace(await api.chooseModel(id, model));
    } catch (e) {
      fail(e);
    }
  }

  async function act(id: AgentId, call: () => Promise<void>) {
    setFollowing(id);
    try {
      await call();
      reload();
    } catch (e) {
      fail(e);
    }
  }

  async function connect(id: AgentId) {
    setBusy(id);
    try {
      replace(await api.connect(id));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <main className="center">
      <div className="stack" style={{ width: 580, gap: 22 }}>
        <h1 className="h1 a-up">Connect an agent</h1>
        <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {list.map((a, i) => {
            const recommended = a.models.find((m) => m.recommended);
            return (
            <li key={a.id} aria-label={a.name} className={`card agent a-up${a.state === 'connected' ? ' on' : ''}`} style={stagger(i + 1)}>
              <div>
                <b>{a.name}</b>
                {a.experimental && <div className="quiet-text">Experimental</div>}
                {a.state !== 'connected' && recommended && <div className="quiet-text">Recommended: {recommended.label}</div>}
                {a.state === 'connected' && a.models.length > 0 && (
                  <label className="model">
                    Model
                    <select className="field" value={a.model ?? ''} onChange={(e) => choose(a.id, e.target.value)}>
                      {a.models.map((m) => <option key={m.id} value={m.id}>{m.recommended ? `${m.label} (recommended)` : m.label}</option>)}
                    </select>
                  </label>
                )}
                {a.untested && <div className="quiet-text">Untested version. It may still work.</div>}
                {a.state === 'missing' && !running(a.install) && !a.install?.problem && <div className="alert">Not installed</div>}
                {a.state === 'signed-out' && <div className="alert">Sign in to {a.name}, then try again.</div>}
                {a.state === 'missing' && a.canInstall && <InstallProgress agent={a} />}
              </div>
              {a.state === 'connected' ? (
                <span className="state"><Status kind="ok" size={24} decorative />Connected</span>
              ) : a.state === 'missing' ? (
                !running(a.install) && (
                  <div className="actions">
                    {a.canInstall && <Button variant="ghost" onClick={() => act(a.id, () => api.installAgent(a.id))}>{a.install?.problem ? 'Try again' : 'Install'}</Button>}
                    <ExternalLink className="btn ghost" href={a.installUrl}>{a.canInstall ? 'Get it myself' : `Get ${a.name}`}</ExternalLink>
                  </div>
                )
              ) : (
                <div className="actions">
                  {/* The agent's own login, where the learner sees it; Codemm never handles credentials. */}
                  {a.state === 'signed-out' && <Button variant="ghost" onClick={() => act(a.id, () => api.signIn(a.id))}>Sign in</Button>}
                  <Button variant="ghost" disabled={busy !== undefined} onClick={() => connect(a.id)}>
                    {a.state === 'not-connected' ? 'Connect' : 'Try again'}
                  </Button>
                </div>
              )}
            </li>
            );
          })}
        </ul>
        <div className="a-up" style={{ ...stagger(4), display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <span className="quiet-text">Codemm uses your agent and your account.</span>
          <Button size="lg" disabled={!list.some((a) => a.state === 'connected')} onClick={() => go(next)}>Continue</Button>
        </div>
      </div>
      {stale !== undefined && <Stale error={stale} retry={reload} />}
    </main>
  );
}

export const running = (install?: AgentInstall) => install !== undefined && install.phase !== 'done' && install.phase !== 'failed';

const VENDOR: Record<AgentId, string> = { claude: 'Anthropic', codex: 'OpenAI', cursor: 'Cursor' };

const PROBLEM: Record<NonNullable<AgentInstall['problem']>, (a: Agent) => string> = {
  offline: () => "You're offline. Connect to the internet, then try again.",
  disk: () => 'Not enough disk space. Free up 1 GB, then try again.',
  unverified: () => "Codemm couldn't verify the installation. Try again.",
  failed: (a) => `${a.name}'s installer didn't finish.`,
};

/** Codemm installing the agent, the vendor's own way: the download, the check, then its installer. */
export function InstallProgress({ agent }: { agent: Agent }) {
  const install = agent.install;
  if (!install || install.phase === 'done') return null;
  if (install.phase === 'failed') return <p className="alert" role="alert">{PROBLEM[install.problem ?? 'failed'](agent)}</p>;
  // Emm filling through the download (its real fraction), the check and the vendor's installer.
  const stage = (['downloading', 'checking', 'installing'] as const).indexOf(install.phase);
  const part = install.phase === 'downloading' ? (install.progress ?? 0) : 0;
  const label = install.phase === 'downloading' ? `Downloading ${agent.name}` : install.phase === 'checking' ? `Checking it's from ${VENDOR[agent.id]}…` : `Installing ${agent.name}…`;
  return <StageFill label={label} stages={3} stage={stage} part={part} text={install.phase === 'downloading' ? `${label} ${Math.round(part * 100)}%` : label} />;
}
