import { useRef, useState } from 'react';
import { notRunLine, type ExampleRun, type Lesson } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';
import { Terminal, type TerminalHandle } from '../../ui/Terminal';
import { useRun } from '../../app/useRun';
import { RunButton } from '../../ui/RunButton';

/**
 * One runnable example: its files, and Run, which runs it in the sandbox through core. Nothing is recorded.
 * An io example runs in the terminal pane with typed input, as an activity's Run does; a unit example runs once as tests.
 */
export function Example({ lesson, index }: { lesson: Lesson; index: number }) {
  const example = lesson.examples[index - 1];
  if (!example) return null;
  return (
    <section className="card example" aria-label={`Example ${index}`}>
      {example.files.map((f) => (
        <div key={f.path}>
          {example.files.length > 1 && <span className="file">{f.path}</span>}
          <pre><code>{f.text}</code></pre>
        </div>
      ))}
      {lesson.style === 'io' ? <LiveRun lesson={lesson} index={index} /> : <RunOnce lesson={lesson} index={index} />}
    </section>
  );
}

function LiveRun({ lesson, index }: { lesson: Lesson; index: number }) {
  const api = useApi();
  const { fail } = useRouter();
  const terminal = useRef<TerminalHandle>(null);
  const program = useRun({ begin: (run) => api.runExampleLive(lesson.id, index, run), terminal, fail });
  // The pane appears with the first Run and stays.
  const [ran, setRan] = useState(false);
  return (
    <>
      <div className="run">
        <RunButton running={program.running} onStop={program.stop} onRun={() => (setRan(true), void program.start())} />
      </div>
      {ran && <Terminal ref={terminal} label={`Terminal for Example ${index}`} status={program.status} onInput={program.input} />}
    </>
  );
}

function RunOnce({ lesson, index }: { lesson: Lesson; index: number }) {
  const api = useApi();
  const { fail } = useRouter();
  const [run, setRun] = useState<ExampleRun>();
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      setRun(await api.runExample(lesson.id, index));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="run">
        <Button variant="ghost" disabled={busy} onClick={start}>Run</Button>
      </div>
      {run?.kind === 'not-run' && <p className="alert" role="status">This didn't run. {notRunLine(run.reason)}</p>}
      {run?.kind === 'ran' && (
        <div role="status">
          {run.output && <pre className="out">{run.output}</pre>}
          {run.errors && <pre className="out err">{run.errors}</pre>}
          {!run.output && !run.errors && <p className="soon">No output.</p>}
        </div>
      )}
    </>
  );
}
