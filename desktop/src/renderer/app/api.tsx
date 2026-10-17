import { createContext, useContext, useEffect, useState, type DependencyList } from 'react';
import type { CodemmApi } from '../../shared/api';

export const ApiContext = createContext<CodemmApi | null>(null);

export function useApi(): CodemmApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi needs an ApiContext');
  return api;
}

/** Loads a value and reloads it whenever Codemm reports a change. */
export function useLive<T>(load: (api: CodemmApi) => Promise<T>, deps: DependencyList): T | undefined {
  const api = useApi();
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let live = true;
    const run = () => load(api).then((v) => live && setValue(v), () => undefined);
    run();
    const off = api.onChange(run);
    return () => {
      live = false;
      off();
    };
  }, [api, ...deps]);
  return value;
}
