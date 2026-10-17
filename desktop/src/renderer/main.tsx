import './styles/fonts.css';
import './styles/tokens.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bridge } from '../shared/api';
import { App } from './app/App';
import { bridgeClient } from './app/api';

declare global {
  interface Window {
    codemm: Bridge;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={bridgeClient(window.codemm)} />
  </StrictMode>,
);
