import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANGED, type Activity } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';

const SAVE_MS = 400;

/**
 * The learner's files, saved by digest shortly after typing stops, before Try
 * it or Check, and when the learner leaves (§4.5). A file changed outside
 * Codemm is reloaded, and `onReloaded` says so.
 */
export function useLearnerFiles(activity: Activity, onReloaded: () => void) {
  const api = useApi();
  const { fail } = useRouter();
  const [files, setFiles] = useState(activity.files);
  const state = useRef({ files: activity.files, dirty: new Set<string>(), chain: Promise.resolve() });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const save = useCallback((): Promise<void> => {
    clearTimeout(timer.current);
    const s = state.current;
    const run = s.chain.then(async () => {
      for (const path of [...s.dirty]) {
        s.dirty.delete(path);
        const file = s.files.find((f) => f.path === path)!;
        try {
          const digest = await api.saveFile(activity.id, path, file.text, file.digest);
          s.files = s.files.map((f) => (f.path === path ? { ...f, digest } : f));
        } catch (e) {
          if (!(e instanceof Error && e.message.includes(CHANGED))) {
            s.dirty.add(path); // kept for the next save
            throw e;
          }
          // Only this file changed outside Codemm: take its new contents, keep every other edit.
          const fresh = (await api.activity(activity.concept)).files.find((f) => f.path === path);
          if (fresh) s.files = s.files.map((f) => (f.path === path ? fresh : f));
          setFiles(s.files);
          onReloaded();
        }
      }
    });
    // A failed save rejects for its caller, but never blocks the saves after it.
    s.chain = run.catch(() => {});
    return run;
  }, [api, activity.id, activity.concept, onReloaded]);

  const edit = useCallback(
    (path: string, text: string) => {
      const s = state.current;
      s.files = s.files.map((f) => (f.path === path ? { ...f, text } : f));
      s.dirty.add(path);
      setFiles(s.files);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => save().catch(fail), SAVE_MS);
    },
    [save, fail],
  );

  // Leaving saves whatever is still unsaved.
  useEffect(() => () => void save().catch(console.error), [save]);

  return { files, edit, save };
}
