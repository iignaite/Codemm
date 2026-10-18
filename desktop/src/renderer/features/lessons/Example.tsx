import { useState } from 'react';
import type { ExampleRun, Lesson } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';

/** One runnable example: its files, and Run, which runs it in the sandbox through core. Nothing is recorded. */
export function Example({ lesson, index }: { lesson: Lesson; index: number }) {
  const api = useApi();
  const { fail } = useRouter();
  const [run, setRun] = useState<ExampleRun>();
  const [busy, setBusy] = useState(false);
  const example = lesson.examples[index - 1];
  if (!example) return null;

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
    <section className="card example" aria-label={`Example ${index}`}>
      {example.files.map((f) => (
        <div key={f.path}>
          {example.files.length > 1 && <span className="file">{f.path}</span>}
          <pre className="code"><code>{f.text}</code></pre>
        </div>
      ))}
      <div className="run">
        <Button variant="ghost" disabled={busy} onClick={start}>Run</Button>
      </div>
      {run?.kind === 'not-run' && <p className="alert" role="status">This didn't run. {run.reason}</p>}
      {run?.kind === 'ran' && (
        <div role="status">
          {run.output && <pre className="out">{run.output}</pre>}
          {run.errors && <pre className="out err">{run.errors}</pre>}
          {!run.output && !run.errors && <p className="soon">No output.</p>}
        </div>
      )}
    </section>
  );
}
