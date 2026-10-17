import { useEffect, useState } from 'react';
import type { Agent } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useNav } from '../../app/nav';
import { Button } from '../../ui/controls';
import { StatusIcon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

/** The only screen that names agents. */
export function Connect() {
  const api = useApi();
  const { go } = useNav();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    api.listAgents().then(setAgents);
  }, [api]);

  async function connect(agent: Agent) {
    setBusy(agent.id);
    const next = await api.connectAgent(agent.id).catch((): Agent => ({ ...agent, state: 'failed', problem: "Couldn't connect." }));
    setAgents((list) => list.map((a) => (a.id === next.id ? next : a)));
    setBusy(undefined);
  }

  return (
    <main className="center">
      <div style={{ width: 580, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <h1 className="h1 a-up">Connect an agent</h1>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {agents.map((agent, i) => (
            <div key={agent.id} className={`card agent a-up ${agent.state === 'connected' ? 'on' : ''}`} style={stagger(i + 1)}>
              <div>
                <b>{agent.name}</b>
                {agent.state === 'failed' && <div className="problem">{agent.problem}</div>}
              </div>
              {agent.state === 'connected'
                ? <span className="state"><StatusIcon status="ok" size={24} label="" />Connected</span>
                : (
                  <Button kind="ghost" disabled={busy === agent.id} onClick={() => connect(agent)}
                    aria-label={agent.state === 'failed' ? `Try ${agent.name} again` : `Connect ${agent.name}`}>
                    {agent.state === 'failed' ? 'Try again' : 'Connect'}
                  </Button>
                )}
            </div>
          ))}
        </div>
        <div className="a-up" style={{ ...stagger(4), display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ fontSize: 14, color: 'var(--muted)' }}>Codemm uses your agent and your plan.</span>
          <Button size="lg" disabled={!agents.some((a) => a.state === 'connected')} onClick={() => go({ to: 'ready' })}>Continue</Button>
        </div>
      </div>
    </main>
  );
}
