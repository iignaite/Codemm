import { useNav } from '../../app/nav';
import { Button } from '../../ui/controls';
import { Emm } from '../../ui/Emm';
import { Logo, Mark, StatusIcon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

/** First run. Monochrome with Emm asleep until an agent connects; then color comes in. */
export function Welcome({ connected }: { connected: boolean }) {
  const { go } = useNav();
  const fx = connected ? 'colorin' : 'bw';
  return (
    <main className="main welcome">
      <div className="welcome-copy">
        <div className={`a-up ${fx}`}><Logo size={30} /></div>
        <h1 className="h1 a-up" style={stagger(1)}>{connected ? 'Ready when you are.' : 'Learn anything.'}</h1>
        <div className="a-up" style={stagger(2)}>
          {connected
            ? <Button size="lg" onClick={() => go({ to: 'goal' })}>Start learning</Button>
            : <Button size="lg" onClick={() => go({ to: 'connect' })}>Connect an agent</Button>}
        </div>
      </div>
      <div className={`welcome-art ${fx}`}>
        <div className="bgmark"><Mark size={440} /></div>
        <Emm mood={connected ? 'wake' : 'sleep'} width={360} />
        {connected && (
          <div className="card connected a-pop" style={stagger(0, 600)}>
            <StatusIcon status="ok" label="" />
            <b>Connected</b>
          </div>
        )}
      </div>
    </main>
  );
}
