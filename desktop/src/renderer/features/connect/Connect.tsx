import { useState } from 'react';
import type { Agent } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter, type Route } from '../../app/router';
import { Failed } from '../../app/Shell';
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
  if (error) return <Failed retry={reload} />;
  if (!list) return null;

  async function connect(id: string) {
    setBusy(id);
    try {
      const agent = await api.connect(id);
      setAgents((current) => (current ?? data)?.map((a) => (a.id === id ? agent : a)));
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
          {list.map((a, i) => (
            <li key={a.id} aria-label={a.name} className={`card agent a-up${a.state === 'connected' ? ' on' : ''}`} style={stagger(i + 1)}>
              <div>
                <b>{a.name}</b>
                <div className="quiet-text">{a.modelHint}</div>
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
          ))}
        </ul>
        <div className="a-up" style={{ ...stagger(4), display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <span className="quiet-text">Codemm uses your agent and your plan.</span>
          <Button size="lg" disabled={!list.some((a) => a.state === 'connected')} onClick={() => go({ to: 'computer', then })}>Continue</Button>
        </div>
      </div>
    </main>
  );
}
