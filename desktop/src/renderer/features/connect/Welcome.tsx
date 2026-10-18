import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Problems';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Status } from '../../ui/Icon';
import { Logo, Mark } from '../../ui/Mark';
import { stagger } from '../../ui/motion';
import { missing } from '../setup/Setup';

/** Monochrome with Emm asleep until an agent is connected; then color comes in. */
export function Welcome() {
  const api = useApi();
  const { go } = useRouter();
  const { data, error, reload } = useLoad(async () => ({ agents: await api.agents(), course: await api.course() }), []);
  // Read beside the agents, so Welcome shows at once: what Codemm could install here.
  const { data: computer } = useLoad(() => api.computer(), []);
  if (error) return <Failed error={error} retry={reload} />;
  if (!data) return null;
  const on = data.agents.some((a) => a.state === 'connected');
  const need = !on && computer ? missing(computer, data.agents) : undefined;
  const install = Boolean(need && (need.docker || need.agent));
  const fx = on ? 'colorin' : 'bw';
  return (
    <main className="welcome">
      <div className="welcome-text">
        <Logo height={26} className={`brand a-up ${fx}`} />
        <h1 className="h1 a-up" style={stagger(1)}>{on ? 'Ready when you are.' : 'Learn anything.'}</h1>
        <div className="a-up" style={stagger(2)}>
          {on ? (
            <Button size="lg" onClick={() => go(data.course ? { to: 'learn' } : { to: 'goal' })}>Start learning</Button>
          ) : install ? (
            <div className="actions">
              <Button size="lg" onClick={() => go({ to: 'setup' })}>Install what's missing</Button>
              <Button variant="text" onClick={() => go({ to: 'connect' })}>Connect an agent</Button>
            </div>
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
            <Status kind="ok" decorative />
            <b>Connected</b>
          </div>
        )}
      </div>
    </main>
  );
}
