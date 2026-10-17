import type { CheckResult } from '../../../shared/api';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Icon, Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

export type Shown =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'run'; output: string }
  | { kind: 'check'; result: CheckResult; keepTrying: boolean };

export interface Ways {
  retry: () => void;
  keepTrying: () => void;
  reread: () => void;
  easier: () => void;
  later: () => void;
  next: () => void;
}

function tone(shown: Shown): string {
  if (shown.kind !== 'check') return 'quiet';
  if (shown.result.kind === 'not-counted') return 'off';
  return shown.result.passed === shown.result.total ? 'ok' : 'nok';
}

/** The results panel under the editor. Its changes are announced. */
export function Results({ shown, name, ways }: { shown: Shown; name?: string; ways: Ways }) {
  return (
    <section className={`res ${tone(shown)}`} aria-live="polite" aria-label="Results">
      <Body shown={shown} name={name} ways={ways} />
    </section>
  );
}

function Body({ shown, name, ways }: { shown: Shown; name?: string; ways: Ways }) {
  if (shown.kind === 'idle') return <div className="idle">Only Check is graded.</div>;
  if (shown.kind === 'busy') return <div className="idle"><span className="busy"><Status kind="run" size={18} />{shown.label}</span></div>;
  if (shown.kind === 'run') return <pre className="output">{shown.output}</pre>;
  const { result } = shown;
  if (result.kind === 'not-counted') {
    return (
      <div className="outcome">
        <Emm mood="soft" width={130} name={name} />
        <div className="stack">
          <h2 className="h2 a-up">This check wasn't counted</h2>
          <p className="sub a-up" style={stagger(1)}>{result.reason}</p>
          <div className="a-up" style={stagger(2)}><Button size="lg" onClick={ways.retry}>Try again</Button></div>
        </div>
      </div>
    );
  }
  if (result.passed === result.total) {
    return (
      <div className="outcome">
        <Emm mood="cheer" width={170} name={name} />
        <div className="stack" style={{ gap: 14 }}>
          <h2 className="h2 won a-pop" style={stagger(0, 300)}>{result.passed} of {result.total} passed</h2>
          {result.progress && <p className="sub a-up" style={stagger(0, 600)}>{result.progress}</p>}
          <div className="a-up" style={stagger(0, 800)}><Button size="lg" onClick={ways.next}>Continue</Button></div>
        </div>
      </div>
    );
  }
  if (result.stuck && !shown.keepTrying) {
    return (
      <div className="outcome">
        <Emm mood="soft" width={130} name={name} />
        <div className="stack" style={{ gap: 10 }}>
          <h2 className="h2 a-up">Try another way</h2>
          <button type="button" className="way a-up" style={stagger(1, 150)} onClick={ways.reread}>Reread the lesson</button>
          <button type="button" className="way a-up" style={stagger(2, 150)} onClick={ways.easier}>Try an easier one</button>
          <button type="button" className="way a-up" style={stagger(3, 150)} onClick={ways.later}>Come back later</button>
          <div className="a-up" style={stagger(4, 150)}><Button variant="text" onClick={ways.keepTrying}>Keep trying</Button></div>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="rhead">
        <Emm mood="think" width={56} name={name} />
        <h2 className="h3">{result.passed} of {result.total} passed</h2>
      </div>
      {result.visible.map((t, i) => (
        <div className="tline a-up" key={t.name} style={stagger(i, 350)}>
          <Status kind={t.status === 'pass' ? 'ok' : 'fail'} />
          {t.name}
          {t.status !== 'pass' && t.expected !== undefined && (
            <span className="cmp">
              <span className="e">expected {t.expected}</span>
              <span className="f">found {t.found}</span>
            </span>
          )}
        </div>
      ))}
      {result.hidden.length > 0 && (
        <div className="hid">
          <b>Hidden tests</b>
          {result.hidden.map((s, i) => (
            <span key={i} className={`x a-pop ${s === 'pass' ? 'pass' : 'fail'}`} style={stagger(i, 800)} role="img" aria-label={`Hidden test ${i + 1} ${s === 'pass' ? 'passed' : 'not yet'}`}>
              {s === 'pass' ? <Icon name="check" color="#0E7C35" size={12} /> : <Icon name="x" color="#8A4B00" size={11} />}
            </span>
          ))}
          <span>graded, not shown</span>
        </div>
      )}
    </>
  );
}
