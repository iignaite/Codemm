import type { CheckResult, TestView, TryResult, VisibleTest } from '../../../shared/api';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Icon, Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

export type Shown =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'try'; result: TryResult }
  | { kind: 'check'; result: CheckResult; keepTrying: boolean };

export interface Ways {
  retry: () => void;
  keepTrying: () => void;
  reread: () => void;
  easier: () => void;
  later: () => void;
  computer: () => void;
  next: () => void;
}

interface Props {
  shown: Shown;
  name: string;
  topic: string;
  visibleTests: VisibleTest[];
  ways: Ways;
}

function tone(shown: Shown): string {
  if (shown.kind !== 'check' && shown.kind !== 'try') return 'quiet';
  if (shown.result.kind === 'not-counted') return 'off';
  if (shown.kind === 'try') return 'quiet';
  return shown.result.passed === shown.result.total ? 'ok' : 'nok';
}

/** The results panel under the editor. Its changes are announced. */
export function Results(props: Props) {
  return (
    <section className={`res ${tone(props.shown)}`} aria-live="polite" aria-label="Results">
      <Body {...props} />
    </section>
  );
}

function Body({ shown, name, topic, visibleTests, ways }: Props) {
  if (shown.kind === 'idle') return <div className="idle">Only Check is graded.</div>;
  if (shown.kind === 'busy') return <div className="idle"><span className="busy"><Status kind="run" size={18} />{shown.label}</span></div>;
  const { result } = shown;
  if (result.kind === 'not-counted') {
    return (
      <div className="outcome">
        <Emm mood="soft" width={130} name={name} />
        <div className="stack">
          <h2 className="h2 a-up">This check wasn't counted</h2>
          <p className="sub a-up" style={stagger(1)}>{result.reason}</p>
          <div className="actions a-up" style={stagger(2)}>
            <Button size="lg" onClick={ways.retry}>Try again</Button>
            <Button variant="ghost" size="lg" onClick={ways.computer}>Check this computer</Button>
          </div>
        </div>
      </div>
    );
  }
  if (result.kind === 'ran') {
    return (
      <>
        <div className="rhead"><h2 className="h3">{result.passed} of {result.total} visible tests passed</h2><span className="quiet-text">Not graded</span></div>
        <TestLines tests={result.tests} visibleTests={visibleTests} />
      </>
    );
  }
  if (result.passed === result.total) {
    return (
      <div className="outcome">
        <Emm mood="cheer" width={170} name={name} />
        <div className="stack" style={{ gap: 14 }}>
          <h2 className="h2 won a-pop" style={stagger(0, 300)}>{result.passed} of {result.total} passed</h2>
          <p className="sub a-up" style={stagger(0, 600)}>{result.mastered ? `${topic} mastered.` : `More practice masters ${topic}.`}</p>
          <div className="a-up" style={stagger(0, 800)}><Button size="lg" onClick={ways.next}>Continue</Button></div>
        </div>
      </div>
    );
  }
  if (result.stuck && shown.kind === 'check' && !shown.keepTrying) {
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
  const hidden = result.tests.filter((t) => t.hidden);
  return (
    <>
      <div className="rhead">
        <Emm mood="think" width={56} name={name} />
        <h2 className="h3">{result.passed} of {result.total} passed</h2>
        {!result.recorded && <span className="quiet-text">Change the code first. This check wasn't counted.</span>}
      </div>
      <TestLines tests={result.tests} visibleTests={visibleTests} />
      {hidden.length > 0 && (
        <div className="hid">
          <b>Hidden tests</b>
          {hidden.map((t, i) => (
            <span key={i} className={`x a-pop ${t.status === 'pass' ? 'pass' : 'fail'}`} style={stagger(i, 800)} role="img" aria-label={`Hidden test ${t.hidden ? t.index : i + 1} ${t.status === 'pass' ? 'passed' : 'not yet'}`}>
              {t.status === 'pass' ? <Icon name="check" color="#0E7C35" size={12} /> : <Icon name="x" color="#8A4B00" size={11} />}
            </span>
          ))}
          <span>graded, not shown</span>
        </div>
      )}
    </>
  );
}

/** The core names visible results "visible/<name>"; the exercise names its tests "<name>". */
const testName = (name: string): string => name.replace(/^visible\//, '');

/** Visible results, with what was expected next to what was found. */
function TestLines({ tests, visibleTests }: { tests: TestView[]; visibleTests: VisibleTest[] }) {
  return (
    <>
      {tests.map((t, i) => {
        if (t.hidden) return null;
        const name = testName(t.name);
        const expected = visibleTests.find((v) => v.name === name)?.expected;
        return (
          <div className="tline a-up" key={t.name} style={stagger(i, 350)}>
            <Status kind={t.status === 'pass' ? 'ok' : 'fail'} />
            {name}
            {t.status !== 'pass' && (t.actual !== undefined || t.message) && (
              <span className="cmp">
                {expected !== undefined && <span className="e">expected {expected}</span>}
                {t.actual !== undefined ? <span className="f">found {t.actual}</span> : <span className="f">{t.message}</span>}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
