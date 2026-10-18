import { useState } from 'react';
import type { Agent, AgentId } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter, type Route } from '../../app/router';
import { Failed, Loading } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

/** The only screen that names agents. Each one that can't run yet shows its next step. */
export function Connect({ then = { to: 'welcome' } }: { then?: Route }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const { data, error, reload } = useLoad(() => api.agents(), []);
  const [agents, setAgents] = useState<Agent[]>();
  const [busy, setBusy] = useState<string>();
  const list = agents ?? data;
  if (error) return <Failed error={error} retry={reload} />;
  if (!list) return <Loading />;

  const replace = (agent: Agent) => setAgents((current) => (current ?? data)?.map((a) => (a.id === agent.id ? agent : a)));

  async function choose(id: AgentId, model: string) {
    try {
      replace(await api.chooseModel(id, model));
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
                {a.state === 'missing' && <div className="alert">Not installed</div>}
                {a.state === 'signed-out' && <div className="alert">Sign in to {a.name}, then try again.</div>}
              </div>
              {a.state === 'connected' ? (
                <span className="state"><Status kind="ok" size={24} />Connected</span>
              ) : (
                <div className="actions">
                  {a.state === 'missing' && <a className="btn ghost" href={a.installUrl} target="_blank" rel="noreferrer">Get {a.name}</a>}
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
          <span className="quiet-text">Codemm uses your agent and your plan.</span>
          <Button size="lg" disabled={!list.some((a) => a.state === 'connected')} onClick={() => go({ to: 'computer', then })}>Continue</Button>
        </div>
      </div>
    </main>
  );
}
