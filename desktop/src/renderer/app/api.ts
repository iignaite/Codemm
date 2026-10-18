import { createContext, useContext } from 'react';
import type { Bridge, CodemmApi } from '../../shared/api';

export const ApiContext = createContext<CodemmApi | null>(null);

export function useApi(): CodemmApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('No CodemmApi provided');
  return api;
}

/** A typed CodemmApi whose every call goes through the preload bridge; check progress and research progress are the bridge's events. */
export function bridgeClient(bridge: Bridge): CodemmApi {
  return new Proxy({} as CodemmApi, {
    get: (_target, method) => {
      if (method === 'onCheckProgress') return bridge.onCheckProgress;
      if (method === 'onResearchProgress') return bridge.onResearchProgress;
      return typeof method === 'string' && method !== 'then' ? (...args: unknown[]) => bridge.invoke(method, args) : undefined;
    },
  });
}
