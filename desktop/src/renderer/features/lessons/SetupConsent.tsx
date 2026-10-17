import type { Proposal } from '../../../shared/api';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Emm } from '../../ui/Emm';

/** The one consent before setup: exactly the files Codemm will build (§4.1). */
export function SetupConsent({ track, proposal, onClose, onSetUp }: { track: string; proposal: Proposal; onClose: () => void; onSetUp: () => void }) {
  return (
    <Dialog
      title={proposal.retry ? `Codemm has another way to set up ${track}.` : `Set up ${track} on this computer?`}
      text="Setup runs code your agent wrote, with internet access. Graded runs are offline."
      art={<Emm mood="look" width={150} name={track} perch />}
      body={
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
      }
      onClose={onClose}
    >
      <Button variant="ghost" size="lg" onClick={onClose}>{proposal.retry ? 'Stop' : 'Not now'}</Button>
      <Button size="lg" onClick={onSetUp}>Set up</Button>
    </Dialog>
  );
}
