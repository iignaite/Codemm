import { useEffect, useRef } from 'react';
import type { Computer as ComputerView, ComputerCheck, DockerInstall, Platform } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter, type Route } from '../../app/router';
import { Failed } from '../../app/Shell';
import { timing, useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { CHECK_NAMES, DETAILS, FIXES, INSTALL, NOT_YET } from './fixes';

const STATE_TEXT = { ok: 'Ready', problem: 'Needs a step', waiting: 'Waiting' } as const;

/** Can this computer run graded checks? Re-checks by itself until it can. */
export function Computer({ then, fromConnect = false }: { then: Route; fromConnect?: boolean }) {
  const api = useApi();
  const { go, fail } = useRouter();
  // One check at a time: a click or focus while one runs waits for its result. The ref is set the moment a
  // check starts, before React re-renders with `loading`, so a focus in between can't start a second one.
  const checking = useRef(false);
  const last = useRef<ComputerView | undefined>(undefined);
  const { data, error, loading, reload } = useLoad(
    async () => {
      checking.current = true;
      try {
        return await api.computer();
      } finally {
        checking.current = false;
      }
    },
    [],
    (c) => c.ready,
    installing(last.current) ? timing.pollMs : timing.recheckMs,
  );
  last.current = data;
  // On the way in from Connect, ready at the first check: nothing to show, so Codemm moves on. An explicit
  // Check this computer, or one where the learner had a step to take, says "This computer is ready." and waits.
  const hadStep = useRef(!fromConnect);
  if (data && !data.ready) hadStep.current = true;
  const ready = data?.ready ?? false;
  useEffect(() => {
    if (ready && !hadStep.current) go(then);
  }, [ready]);
  const recheck = () => {
    if (!checking.current) reload();
  };
  const list = useRef<HTMLUListElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const focusInList = useRef(false);

  // Coming back to the window re-checks at once.
  useEffect(() => {
    if (data?.ready || loading) return;
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [data?.ready, loading, reload]);

  // A re-check can remove the step that had focus; move focus to the next action.
  useEffect(() => {
    if (focusInList.current && document.activeElement === document.body) {
      focusInList.current = false;
      action.current?.focus();
    }
  }, [data]);

  async function act(call: () => Promise<void>) {
    try {
      await call();
      recheck();
    } catch (e) {
      fail(e);
    }
  }

  if (error) return <Failed error={error} retry={reload} />;
  if (!data || (data.ready && !hadStep.current)) return null;
  const problem = data.checks.find((c) => c.state === 'problem');
  return (
    <main className="center">
      <div className="stack" style={{ width: 620, gap: 22 }}>
        <h1 className="h1 a-up">Check this computer</h1>
        <p className="sub a-up" style={stagger(1)}>Codemm runs your code in Docker, on this computer.</p>
        <ul className="stack plain" ref={list} onFocus={() => (focusInList.current = true)}>
          {data.checks.map((c, i) => (
            <CheckItem key={c.id} check={c} computer={data} index={i} onInstall={() => act(() => api.installDocker())} onOpen={() => act(() => api.openDocker())} />
          ))}
        </ul>
        <p className="quiet-text" role="status">
          {data.ready
            ? 'This computer is ready.'
            : installing(data)
              ? 'Installing Docker Desktop.'
              : `${problem ? `${problem.detail ? DETAILS[problem.detail].notYet : NOT_YET[problem.id]} ` : ''}Checking again every few seconds.`}
        </p>
        <div className="actions">
          {data.ready ? (
            <Button ref={action} size="lg" onClick={() => go(then)}>Continue</Button>
          ) : (
            <>
              <Button ref={action} variant="ghost" size="lg" onClick={recheck}>Check now</Button>
              <Button variant="text" onClick={() => go(then)}>Later</Button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/** Codemm is downloading or installing Docker; once it's starting, Check this computer speaks for Docker. */
const installing = (c?: ComputerView) => Boolean(c?.install && c.install.phase !== 'failed' && c.install.phase !== 'starting');

interface ItemProps {
  check: ComputerCheck;
  computer: ComputerView;
  index: number;
  onInstall: () => void;
  onOpen: () => void;
}

function CheckItem({ check, computer, index, onInstall, onOpen }: ItemProps) {
  const name = CHECK_NAMES[check.id];
  const platform = computer.platform;
  // Right after Codemm installed Docker, its first start asks the learner to accept Docker's terms.
  const justInstalled = check.detail === 'starting' && computer.install?.phase === 'starting';
  const fix = check.state !== 'problem' ? undefined : justInstalled ? { steps: [INSTALL.phase.starting] } : check.detail ? DETAILS[check.detail].fix : FIXES[platform][check.id];
  const offerInstall = check.state === 'problem' && check.id === 'docker-installed' && computer.canInstall;
  const offerOpen = check.state === 'problem' && check.id === 'docker-running' && !check.detail && computer.canInstall;
  const busy = Boolean(offerInstall && installing(computer));
  return (
    <li className={`card check a-up${check.state === 'ok' ? ' on' : ''}`} style={stagger(index + 2)} aria-label={name}>
      <div className="check-head">
        {check.state === 'ok' && <Status kind="ok" size={24} />}
        {check.state === 'problem' && (busy ? <Status kind="run" size={24} /> : <Status kind="fail" size={24} label="Needs a step" />)}
        {check.state === 'waiting' && <span className="ico wait" aria-hidden="true" />}
        <b>{name}</b>
        <span className={`check-state ${busy ? 'waiting' : check.state}`}>{busy ? 'Installing' : STATE_TEXT[check.state]}</span>
      </div>
      {offerInstall && fix ? (
        <InstallDocker install={computer.install} platform={platform} manualUrl={fix.link?.url} onInstall={onInstall} />
      ) : (
        fix && (
          <div className="fix">
            <ol>{fix.steps.map((s) => <li key={s}>{s}</li>)}</ol>
            <div className="actions">
              {offerOpen && <Button onClick={onOpen}>Open Docker Desktop</Button>}
              {fix.link && <a className="btn ghost" href={fix.link.url} target="_blank" rel="noreferrer">{fix.link.label}</a>}
            </div>
          </div>
        )
      )}
    </li>
  );
}

/** Codemm installs Docker Desktop from Docker, checked, with Docker's own window for its terms (§6.1). */
function InstallDocker({ install, platform, manualUrl, onInstall }: { install?: DockerInstall; platform: Platform; manualUrl?: string; onInstall: () => void }) {
  if (install && install.phase !== 'failed') {
    const text = install.phase === 'installing' ? INSTALL.phase.installing[platform] : INSTALL.phase[install.phase];
    return (
      <div className="fix install">
        {install.phase === 'downloading' ? (
          <div className="stack" style={{ gap: 8 }}>
            <span>{text} {Math.round((install.progress ?? 0) * 100)}%</span>
            <div className="bar" role="progressbar" aria-label={text} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((install.progress ?? 0) * 100)}>
              <i style={{ width: `${Math.round((install.progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        ) : (
          <div className="busy"><Status kind="run" size={18} />{text}</div>
        )}
      </div>
    );
  }
  const problem = install?.problem;
  return (
    <div className="fix install">
      {problem && <p className="alert" role="alert">{INSTALL.problem[problem]}</p>}
      <div className="actions">
        {(!problem || INSTALL.retry.has(problem)) && <Button onClick={onInstall}>{problem ? 'Try again' : 'Install Docker'}</Button>}
        {manualUrl && <a className="btn ghost" href={manualUrl} target="_blank" rel="noreferrer">Install it myself</a>}
      </div>
      <p className="quiet-text">
        {INSTALL.terms} <a className="inline" href={INSTALL.termsUrl} target="_blank" rel="noreferrer">Read them</a>
      </p>
    </div>
  );
}
