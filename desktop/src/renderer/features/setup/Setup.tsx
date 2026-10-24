import { useEffect, useState } from 'react';
import type { Agent, AgentId, Computer, DockerInstall } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed, Stale } from '../../app/Problems';
import { timing, useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { FIXES, INSTALL } from '../computer/fixes';
import { InstallProgress, running } from '../connect/Connect';
import { DockerProgress } from '../computer/DockerProgress';
import { ExternalLink } from '../../ui/ExternalLink';

/** Each agent's maker and terms, for the learner's go-ahead. */
const TERMS: Partial<Record<AgentId, { vendor: string; url: string }>> = {
  claude: { vendor: 'Anthropic', url: 'https://www.anthropic.com/legal/consumer-terms' },
  codex: { vendor: 'OpenAI', url: 'https://openai.com/policies/' },
};

/** What Codemm can install here: Docker when it isn't installed, and an agent when none is. */
export function missing(computer: Computer, agents: Agent[]) {
  const docker = Boolean(computer.canInstall && computer.checks.find((c) => c.id === 'docker-installed')?.state === 'problem');
  const agent = agents.every((a) => a.state === 'missing') && agents.some((a) => a.canInstall);
  return { docker, agent };
}

const dockerBusy = (install?: DockerInstall) => install !== undefined && install.phase !== 'starting' && install.phase !== 'failed';

/**
 * One action installs everything missing: Docker and the chosen agent, each the maker's own way, side by side.
 * Docker's terms window comes first, then the agent's own sign-in. Nothing downloads before the learner says so.
 */
export function Setup() {
  const api = useApi();
  const { go, fail } = useRouter();
  const [wanted, setWanted] = useState<{ docker: boolean; agent?: AgentId }>();
  const [choice, setChoice] = useState<AgentId>('claude');
  // Until an agent is connected, look again every few seconds, so one installed elsewhere drops off the list. Once
  // started, follow both installs. Coming back from a sign-in or Docker's window looks again too.
  const { data, error, stale, reload } = useLoad(async () => ({ computer: await api.computer(), agents: await api.agents() }), [wanted], {
    settled: (d) => !wanted && d.agents.some((a) => a.state === 'connected'),
    every: wanted ? timing.pollMs : timing.agentsMs,
    onFocus: true,
  });
  const agent = wanted?.agent ? data?.agents.find((a) => a.id === wanted.agent) : undefined;
  const ready = Boolean(wanted && data && (!wanted.docker || data.computer.ready) && (!wanted.agent || agent?.state === 'connected'));
  useEffect(() => {
    if (ready) go({ to: 'goal' });
  }, [ready]);
  // Everything was installed elsewhere meanwhile: connecting the agent is what's left.
  const nothing = Boolean(!wanted && data && !Object.values(missing(data.computer, data.agents)).some(Boolean));
  useEffect(() => {
    if (nothing) go({ to: 'connect', then: { to: 'goal' } });
  }, [nothing]);

  if (error) return <Failed error={error} retry={reload} />;
  if (!data) return null;
  const need = wanted ?? missing(data.computer, data.agents);
  const choices = data.agents.filter((a) => a.canInstall);

  async function start() {
    const next = { docker: need.docker, ...(need.agent ? { agent: choice } : {}) };
    try {
      if (next.docker) await api.installDocker();
      if (next.agent) await api.installAgent(next.agent);
      setWanted(next);
    } catch (e) {
      fail(e);
    }
  }

  async function act(call: () => Promise<void>) {
    try {
      await call();
      reload();
    } catch (e) {
      fail(e);
    }
  }

  const install = data.computer.install;
  const dockerInstalled = data.computer.checks.find((c) => c.id === 'docker-installed')?.state === 'ok';
  return (
    <main className="center">
      <div className="stack wide setup-page">
        <h1 className="h1 a-up">Set up this computer</h1>
        <p className="sub a-up" style={stagger(1)}>Codemm installs what's missing, each from its maker.</p>
        <ul className="stack plain">
          {need.docker && (
            <li className="card check a-up" style={stagger(2)} aria-label="Docker Desktop">
              <div className="check-head">
                {data.computer.ready && <Status kind="ok" size={24} />}
                <b>Docker Desktop</b>
                {!wanted && <span className="check-state problem">Not installed</span>}
              </div>
              {!wanted ? (
                <p className="quiet-text">{INSTALL.terms} <ExternalLink className="inline" href={INSTALL.termsUrl}>Read them</ExternalLink></p>
              ) : data.computer.ready ? (
                <span className="quiet-text">Ready</span>
              ) : install?.phase === 'failed' ? (
                <div className="fix">
                  <p className="alert" role="alert">{INSTALL.problem[install.problem ?? 'failed']}</p>
                  {INSTALL.retry.has(install.problem) && <div className="actions"><Button onClick={() => act(() => api.installDocker())}>Try again</Button></div>}
                  {install.problem === 'windows-version' && <div className="actions"><Button onClick={() => act(() => api.openWindowsUpdate())}>Open Windows Update</Button></div>}
                </div>
              ) : !install && dockerInstalled ? (
                // Docker's start window ended and it still isn't running: Check this computer's own step.
                <div className="fix">
                  <p>{FIXES[data.computer.platform]['docker-running'].steps.join(' ')}</p>
                  <div className="actions">
                    <Button onClick={() => act(() => api.openDocker())}>Open Docker Desktop</Button>
                    <Button variant="ghost" onClick={reload}>Check now</Button>
                  </div>
                </div>
              ) : (
                // Until Docker's first state arrives, its download is just starting: never "Opening Docker" yet.
                <DockerProgress install={install ? { ...install, phase: install.phase } : { phase: 'downloading', progress: 0 }} platform={data.computer.platform} />
              )}
            </li>
          )}
          {need.agent && (
            <li className="card check a-up" style={stagger(3)} aria-label="Agent">
              <div className="check-head">
                {agent?.state === 'connected' && <Status kind="ok" size={24} />}
                <b id="agent-t">{agent ? agent.name : 'Your agent'}</b>
              </div>
              {!wanted ? (
                <>
                  <div className="depth" role="radiogroup" aria-labelledby="agent-t">
                    {choices.map((a) => (
                      <label key={a.id} className={`opt${choice === a.id ? ' on' : ''}`}>
                        <input type="radio" name="agent" value={a.id} checked={choice === a.id} onChange={() => setChoice(a.id)} />
                        {a.name}
                      </label>
                    ))}
                  </div>
                  {TERMS[choice] && (
                    <p className="quiet-text">{choices.find((a) => a.id === choice)?.name} is from {TERMS[choice]!.vendor}. Its terms apply. <ExternalLink className="inline" href={TERMS[choice]!.url}>Read them</ExternalLink></p>
                  )}
                </>
              ) : agent?.state === 'connected' ? (
                <span className="quiet-text">Ready</span>
              ) : agent?.state === 'signed-out' ? (
                <div className="actions">
                  {/* Docker's terms window first, then the agent's own sign-in. */}
                  <Button disabled={need.docker && dockerBusy(install)} onClick={() => act(() => api.signIn(agent.id))}>Sign in</Button>
                </div>
              ) : agent ? (
                <>
                  <InstallProgress agent={agent} />
                  {agent.install?.phase === 'failed' && <div className="actions"><Button onClick={() => act(() => api.installAgent(agent.id))}>Try again</Button></div>}
                  {!running(agent.install) && agent.install?.phase !== 'failed' && <span className="quiet-text">Checking</span>}
                </>
              ) : null}
            </li>
          )}
        </ul>
        {!wanted && (
          <div className="actions a-up" style={stagger(4)}>
            <Button size="lg" onClick={start}>Install what's missing</Button>
            <Button variant="text" onClick={() => go({ to: 'connect', then: { to: 'goal' } })}>Do it myself</Button>
          </div>
        )}
      </div>
      {stale !== undefined && <Stale error={stale} retry={reload} />}
    </main>
  );
}

