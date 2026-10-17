import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-600.css';
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
