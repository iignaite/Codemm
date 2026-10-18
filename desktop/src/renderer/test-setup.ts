import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

// Codemm's background work moves on each read in the mock, so tests can poll fast.
import { timing } from './app/useLoad';
timing.pollMs = 5;
timing.recheckMs = 5;

// xterm.js asks for a canvas context as it loads; jsdom has none and logs each time. No context, quietly.
// (Node-environment tests share this file and have no DOM.)
if (typeof HTMLCanvasElement !== 'undefined') HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
