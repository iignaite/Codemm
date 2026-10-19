// The app's entry point. main.ts starts Codemm, so it loads only in the first instance: a second launch quits before
// it starts anything, and the first shows its window (main.ts, DESIGN §2).
import { app } from 'electron';
import { startOnce } from './instance';

startOnce(app, () => require('./main'));
