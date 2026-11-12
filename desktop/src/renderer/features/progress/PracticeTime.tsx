import { useState } from 'react';
import type { PracticeTime as Plan } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useBusy } from '../../app/useBusy';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';

/**
 * A repeating practice time, saved as a calendar file the learner adds to their own calendar (§4.15): the reason to
 * come back tomorrow, with no account or server. Codemm keeps no copy of the choice.
 */
export function PracticeTime() {
  const api = useApi();
  const { fail } = useRouter();
  const saving = useBusy();
  const [time, setTime] = useState('19:00');
  const [repeat, setRepeat] = useState<Plan['repeat']>('daily');
  const [saved, setSaved] = useState(false);

  const save = () => saving.guard(async () => {
    try {
      const result = await api.savePracticeTime({ time, repeat });
      setSaved(result.saved);
    } catch (e) {
      fail(e);
    }
  });

  return (
    <section className="card practice-time" aria-labelledby="practice-time-t">
      <h2 className="h3" id="practice-time-t">Practice time</h2>
      <p className="quiet-text">Pick a time to practice. Codemm saves it as a repeating event for your calendar.</p>
      <div className="practice-time-row">
        <label className="practice-time-field">
          <span>Time</span>
          <input type="time" className="field" required value={time} onChange={(e) => (setTime(e.target.value), setSaved(false))} />
        </label>
        <label className="practice-time-field">
          <span>How often</span>
          <select className="field" value={repeat} onChange={(e) => (setRepeat(e.target.value as Plan['repeat']), setSaved(false))}>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
          </select>
        </label>
      </div>
      <Button variant="ghost" disabled={!time || saving.busy} onClick={save}>Save to calendar</Button>
      <p className="quiet-text" role="status">{saved ? 'Saved. Open the file to add it to your calendar.' : ''}</p>
    </section>
  );
}
