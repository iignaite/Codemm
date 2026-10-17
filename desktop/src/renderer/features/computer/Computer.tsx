import { useEffect, useRef } from 'react';
import type { ComputerCheck, Platform } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter, type Route } from '../../app/router';
import { Failed } from '../../app/Shell';
import { timing, useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { CHECK_NAMES, FIXES, NOT_YET } from './fixes';

const STATE_TEXT = { ok: 'Ready', problem: 'Needs a step', waiting: 'Waiting' } as const;

/** Can this computer run graded checks? Re-checks by itself until it can. */
export function Computer({ then }: { then: Route }) {
  const api = useApi();
  const { go } = useRouter();
  const { data, error, reload } = useLoad(() => api.computer(), [], (c) => c.ready, timing.recheckMs);
  const list = useRef<HTMLUListElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const focusInList = useRef(false);

  // A re-check can remove the step that had focus; move focus to the next action.
  useEffect(() => {
    if (focusInList.current && document.activeElement === document.body) {
      focusInList.current = false;
      action.current?.focus();
    }
  }, [data]);

  if (error) return <Failed retry={reload} />;
  if (!data) return null;
  const problem = data.checks.find((c) => c.state === 'problem');
  return (
    <main className="center">
      <div className="stack" style={{ width: 620, gap: 22 }}>
        <h1 className="h1 a-up">Check this computer</h1>
        <p className="sub a-up" style={stagger(1)}>Codemm runs your code in Docker, on this computer.</p>
        <ul className="stack plain" ref={list} onFocus={() => (focusInList.current = true)}>
          {data.checks.map((c, i) => <CheckItem key={c.id} check={c} platform={data.platform} index={i} />)}
        </ul>
        <p className="quiet-text" role="status">
          {data.ready ? 'This computer is ready.' : `${problem ? `${NOT_YET[problem.id]} ` : ''}Checking again every few seconds.`}
        </p>
        <div className="actions">
          {data.ready ? (
            <Button ref={action} size="lg" onClick={() => go(then)}>Continue</Button>
          ) : (
            <>
              <Button ref={action} variant="ghost" size="lg" onClick={reload}>Check now</Button>
              <Button variant="text" onClick={() => go(then)}>Later</Button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function CheckItem({ check, platform, index }: { check: ComputerCheck; platform: Platform; index: number }) {
  const name = CHECK_NAMES[check.id];
  const fix = check.state === 'problem' ? FIXES[platform][check.id] : undefined;
  return (
    <li className={`card check a-up${check.state === 'ok' ? ' on' : ''}`} style={stagger(index + 2)} aria-label={name}>
      <div className="check-head">
        {check.state === 'ok' && <Status kind="ok" size={24} />}
        {check.state === 'problem' && <Status kind="fail" size={24} label="Needs a step" />}
        {check.state === 'waiting' && <span className="ico wait" aria-hidden="true" />}
        <b>{name}</b>
        <span className={`check-state ${check.state}`}>{STATE_TEXT[check.state]}</span>
      </div>
      {fix && (
        <div className="fix">
          <ol>{fix.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          {fix.link && <a className="btn ghost" href={fix.link.url} target="_blank" rel="noreferrer">{fix.link.label}</a>}
        </div>
      )}
    </li>
  );
}
