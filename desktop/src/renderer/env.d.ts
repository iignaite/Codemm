import type { CodemmApi } from '../shared/api';

declare global {
  interface Window {
    codemm: CodemmApi;
  }
}
