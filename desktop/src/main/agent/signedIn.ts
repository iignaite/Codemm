// The agent's own sign-in status (DESIGN §3.1): yes or no only when the agent says which. A busy computer can take
// 20 s to answer, so a check with no answer in time is asked once more, with longer. One that still can't tell, or a
// no while the network is down, is null, never "signed out".
import type { AgentId } from '../../shared/api';
import { AGENT_CLIS } from './agents';
import { ask, type Executable } from './bridge';
import { OFFLINE } from './jobs';

/** The first bound, then the one retry's. */
const BOUNDS_MS = [10_000, 60_000];

export async function signedInOf(id: AgentId, exe: Executable, bounds = BOUNDS_MS): Promise<boolean | null> {
  const { args, read } = AGENT_CLIS[id].signIn;
  for (const timeoutMs of bounds) {
    // Wrapped, so an answer that can't tell stays apart from no answer in time (ask's null).
    const answer = await ask(exe, args, (r) => {
      const ok = read(r);
      return { ok: ok === false && OFFLINE.test(r.output) ? null : ok };
    }, { timeoutMs });
    if (answer) return answer.ok;
  }
  return null;
}
