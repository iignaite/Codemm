import type { Graded, Infra, Tested, VisibleTest } from '../../../shared/api';
import { Button } from '../../ui/controls';
import { Emm } from '../../ui/Emm';
import { Icon, StatusIcon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import type { PaletteName } from '../../ui/palette';

export type ResultState = { kind: 'idle' } | { kind: 'running' } | Tested | Graded | Infra;

interface Props {
  state: ResultState;
  topic: string;
  palette?: PaletteName;
  onRetry: () => void;
  onContinue: () => void;
  onLesson: () => void;
  onEasier: () => void;
  onLater: () => void;
  onDismiss: () => void;
}

function Visible({ tests, delay }: { tests: VisibleTest[]; delay: number }) {
  return tests.map((t, i) => (
    <div key={t.name} className="tline a-up" style={stagger(i, delay)}>
      <StatusIcon status={t.passed ? 'ok' : 'fail'} />
      {t.name}
      {!t.passed && (t.expected !== undefined || t.found !== undefined) && (
        <span className="cmp">
          {t.expected !== undefined && <span className="e">expected {t.expected}</span>}
          {t.found !== undefined && <span className="f">found {t.found}</span>}
        </span>
      )}
    </div>
  ));
}

function Hidden({ hidden }: { hidden: Graded['hidden'] }) {
  return (
    <div className="hid">
      <b>Hidden tests</b>
      {hidden.map((s, i) => (
        <span key={i} className={`x a-pop ${s}`} style={stagger(i, 800)} role="img" aria-label={`Hidden test ${i + 1} ${s === 'passed' ? 'passed' : 'not yet'}`}>
          {s === 'passed' ? <Icon name="check" color="#0E7C35" size={12} /> : <Icon name="x" color="#8A4B00" size={11} />}
        </span>
      ))}
      <span>graded, not shown</span>
    </div>
  );
}

function Body({ state, topic, palette, onRetry, onContinue, onLesson, onEasier, onLater, onDismiss }: Props) {
  switch (state.kind) {
    case 'idle':
      return <div className="calm">Only Check is graded.</div>;
    case 'running':
      return <div className="calm"><span className="status"><StatusIcon status="run" size={18} label="" />Checking</span></div>;
    case 'tested':
      return <>
        <div className="rhead">
          <h2 className="h3">{state.visible.filter((t) => t.passed).length} of {state.visible.length} passed</h2>
          <span className="status">Not graded</span>
        </div>
        <Visible tests={state.visible} delay={150} />
      </>;
    case 'infra':
      return (
        <div className="split">
          <Emm mood="soft" width={130} perch={false} palette={palette} />
          <div>
            <h2 className="h2 a-up" style={{ fontSize: 24 }}>This check wasn't counted</h2>
            <p className="sub a-up" style={stagger(1)}>{state.problem}</p>
            <div className="a-up" style={stagger(2)}><Button size="lg" onClick={onRetry}>Try again</Button></div>
          </div>
        </div>
      );
  }
  if (state.passed === state.total) {
    return (
      <div className="split" style={{ gap: 32, paddingLeft: 8 }}>
        <Emm mood="cheer" width={170} perch={false} palette={palette} />
        <div>
          <h2 className="h2 a-pop" style={{ ...stagger(0, 300), color: 'var(--green-ink)', transformOrigin: 'left' }}>{state.passed} of {state.total} passed</h2>
          <p className="sub a-up" style={stagger(0, 600)}>{state.mastered ? `${topic} mastered.` : `Keep going to master ${topic}.`}</p>
          <div className="a-up" style={stagger(0, 800)}><Button size="lg" onClick={onContinue}>Continue</Button></div>
        </div>
      </div>
    );
  }
  if (state.stuck) {
    const ways: [string, () => void][] = [['Reread the lesson', onLesson], ['Try an easier one', onEasier], ['Come back later', onLater]];
    return (
      <div className="split">
        <Emm mood="soft" width={130} perch={false} palette={palette} />
        <div>
          <h2 className="h2 a-up" style={{ fontSize: 24 }}>Try another way</h2>
          {ways.map(([label, act], i) => (
            <button key={label} type="button" className={`card way a-up ${i === 0 ? 'first' : ''}`} style={stagger(i + 1, 150)} onClick={act}>{label}</button>
          ))}
          <div className="a-up" style={stagger(4, 150)}><Button kind="text" onClick={onDismiss}>Keep trying</Button></div>
        </div>
      </div>
    );
  }
  return <>
    <div className="rhead">
      <Emm mood="think" width={56} perch={false} palette={palette} />
      <h2 className="h3" style={{ color: 'var(--orange-ink)' }}>{state.passed} of {state.total} passed</h2>
      {!state.recorded && <span className="status">Not counted. Change the code first.</span>}
    </div>
    <Visible tests={state.visible} delay={350} />
    <Hidden hidden={state.hidden} />
  </>;
}

const TONE: Record<string, string> = { idle: 'quiet', running: 'quiet', tested: 'quiet', infra: 'off' };

function tone(state: ResultState): string {
  if (state.kind !== 'graded') return TONE[state.kind];
  return state.passed === state.total ? 'ok' : 'nok';
}

/** The results panel. Hidden tests show an index and a status only. */
export function Results(props: Props) {
  return (
    <section className={`res ${tone(props.state)}`} aria-live="polite" aria-label="Results">
      <Body {...props} />
    </section>
  );
}
