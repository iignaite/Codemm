import { useState } from 'react';
import type { CourseView, Proposal } from '../../../shared/api';
import { useApi } from '../../app/api';
import { problemOf } from '../../app/errors';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Emm } from '../../ui/Emm';
import { Banner } from '../../ui/Banner';

/** The one consent before setup: exactly the files Codemm will build (§4.1). */
type Props = { track: string; proposal: Proposal; error?: string; onClose: () => void; onSetUp: () => void };

export function SetupConsent({ track, proposal, error, onClose, onSetUp }: Props) {
  return (
    <Dialog
      title={proposal.retry ? `Codemm has another way to set up ${track}.` : `Set up ${track} on this computer?`}
      text="Setup runs code your agent wrote, with internet access. Graded runs are offline."
      art={<Emm mood="look" width={150} name={track} perch />}
      body={
        <>
        {error && <p className="alert" role="alert">{error}</p>}
        <details className="details">
          <summary>Details</summary>
          <p className="quiet-text">The build stops after 10 minutes, and has no memory or CPU limit.</p>
          {proposal.files.map((f) => (
            <section key={f.path} aria-label={f.path}>
              <b>{f.path}</b>
              <pre className="pre">{f.text}</pre>
            </section>
          ))}
        </details>
        </>
      }
      onClose={onClose}
    >
      <Button variant="ghost" size="lg" onClick={onClose}>{proposal.retry ? 'Stop' : 'Not now'}</Button>
      <Button size="lg" onClick={onSetUp}>Set up</Button>
    </Dialog>
  );
}

/**
 * Setup's consent, wherever the learner is. The topic page opens it at once; a lesson offers it in a banner, so
 * reading never waits on it. After a change or a failed install it shows the latest proposal, and says why.
 */
export function SetupOffer({ course, banner = false, onChange }: { course: CourseView; banner?: boolean; onChange: () => void }) {
  const api = useApi();
  const { fail } = useRouter();
  const [open, setOpen] = useState(!banner);
  const [error, setError] = useState<string>();
  const proposal = course.setup === 'consent' ? course.proposal : undefined;
  if (!proposal) return null;

  async function install(digest: string) {
    try {
      await api.install(digest);
      setError(undefined);
    } catch (e) {
      if (problemOf(e) === 'connect') return fail(e);
      // The proposal changed since the learner saw it: show the new one, and say why.
      setError((e as Error).message);
    }
    onChange();
  }

  const offer = <Button onClick={() => setOpen(true)}>Set up {course.track}</Button>;
  return (
    <>
      {!open && (banner ? <Banner action={offer}>{course.track} isn't set up yet.</Banner> : <div className="a-up">{offer}</div>)}
      {open && <SetupConsent track={course.track} proposal={proposal} error={error} onClose={() => setOpen(false)} onSetUp={() => install(proposal.digest)} />}
    </>
  );
}
