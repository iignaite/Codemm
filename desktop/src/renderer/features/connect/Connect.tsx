import { useState } from 'react';
import type { Agent } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

/** The only screen that names agents. A failed sign-in shows its fix. */
export function Connect() {
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
                {a.modelHint && <div className="quiet-text">{a.modelHint}</div>}
                {a.state === 'failed' && <div className="alert">{a.fix}</div>}
              </div>
              {a.state === 'connected' ? (
                <span className="state"><Status kind="ok" size={24} />Connected</span>
              ) : (
                <Button variant="ghost" disabled={busy !== undefined} onClick={() => connect(a.id)}>
                  {a.state === 'failed' ? 'Try again' : 'Connect'}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="a-up" style={{ ...stagger(4), display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <span className="quiet-text">Codemm uses your agent and your plan.</span>
          <Button size="lg" disabled={!list.some((a) => a.state === 'connected')} onClick={() => go({ to: 'computer', then: { to: 'welcome' } })}>Continue</Button>
        </div>
      </div>
    </main>
  );
}
