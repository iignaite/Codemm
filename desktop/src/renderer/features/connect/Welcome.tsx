import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed, Loading } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Status } from '../../ui/Icon';
import { Logo, Mark } from '../../ui/Mark';
import { stagger } from '../../ui/motion';

/** Monochrome with Emm asleep until an agent is connected; then color comes in. */
export function Welcome() {
  const api = useApi();
  const { go } = useRouter();
  const { data, error, reload } = useLoad(async () => ({ agents: await api.agents(), course: await api.course() }), []);
  if (error) return <Failed error={error} retry={reload} />;
  if (!data) return <Loading />;
  const on = data.agents.some((a) => a.state === 'connected');
  const fx = on ? 'colorin' : 'bw';
  return (
    <main className="welcome">
      <div className="welcome-text">
        <Logo height={26} className={`brand a-up ${fx}`} />
        <h1 className="h1 a-up" style={stagger(1)}>{on ? 'Ready when you are.' : 'Learn anything.'}</h1>
        <div className="a-up" style={stagger(2)}>
          {on ? (
            <Button size="lg" onClick={() => go(data.course ? { to: 'learn' } : { to: 'goal' })}>Start learning</Button>
          ) : (
            <Button size="lg" onClick={() => go({ to: 'connect' })}>Connect an agent</Button>
          )}
        </div>
      </div>
      <div className={`welcome-art ${fx}`}>
        <div className="bg"><Mark size={440} /></div>
        <Emm mood={on ? 'wake' : 'sleep'} width={360} perch />
        {on && (
          <div className="card connected a-pop" style={stagger(0, 600)}>
            <Status kind="ok" />
            <b>Connected</b>
          </div>
        )}
      </div>
    </main>
  );
}
