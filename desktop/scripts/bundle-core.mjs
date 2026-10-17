// Bundles Codemm's core from the repository into out/core (DESIGN §7): the
// CLI, which the app runs as `codemm mcp` with Electron as Node, and the app
// module main loads in-process. Learners then need no Node, npm or terminal.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(desktop, '..');
const out = join(desktop, 'out', 'core');
const common = { bundle: true, platform: 'node', target: 'node22', logLevel: 'warning' };

mkdirSync(join(out, 'dist'), { recursive: true });
await build({
  ...common,
  entryPoints: [join(repo, 'src', 'cli.ts')],
  format: 'esm',
  outfile: join(out, 'dist', 'cli.mjs'),
  // Bundled CommonJS dependencies still call require.
  banner: { js: "import { createRequire as __codemmRequire } from 'node:module'; const require = __codemmRequire(import.meta.url);" },
});
await build({ ...common, entryPoints: [join(desktop, 'scripts', 'core-entry.ts')], format: 'cjs', outfile: join(out, 'dist', 'app.cjs') });
// The CLI reads its version from ../package.json.
copyFileSync(join(repo, 'package.json'), join(out, 'package.json'));
