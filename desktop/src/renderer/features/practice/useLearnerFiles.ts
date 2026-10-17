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
    s.chain = s.chain.then(async () => {
      for (const path of [...s.dirty]) {
        s.dirty.delete(path);
        const file = s.files.find((f) => f.path === path)!;
        try {
          const digest = await api.saveFile(activity.id, path, file.text, file.digest);
          s.files = s.files.map((f) => (f.path === path ? { ...f, digest } : f));
        } catch (e) {
          if (!(e instanceof Error && e.message.includes(CHANGED))) throw e;
          const fresh = await api.activity(activity.concept);
          s.files = fresh.files;
          s.dirty.clear();
          setFiles(fresh.files);
          onReloaded();
          return;
        }
      }
    });
    return s.chain;
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
