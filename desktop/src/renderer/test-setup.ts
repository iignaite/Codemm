import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

// Codemm's background work moves on each read in the mock, so tests can poll fast.
import { timing } from './app/useLoad';
timing.pollMs = 5;
timing.recheckMs = 5;
