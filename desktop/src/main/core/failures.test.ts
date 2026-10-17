// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { infra } from './failures';

describe('core failure messages (src/sandbox.ts, src/judge.ts, src/store.ts)', () => {
  it('tells this computer\'s problems from a track\'s', () => {
    expect(infra('Not enough disk space. Setup needs 5 GB free where Codemm keeps its data (/x). Free some space, then try again.')).toBe('disk');
    expect(infra('Docker ran out of disk space while building the track, so nothing was installed.')).toBe('disk');
    expect(infra("The track build couldn't reach the network (could not resolve host), so nothing was installed.")).toBe('offline');
    expect(infra("The container runtime isn't running. Start Docker Desktop and wait until it says it's running, then retry.")).toBe('docker');
    expect(infra('No container runtime found. Install Docker Desktop for Mac.')).toBe('docker');
    expect(infra("The container runtime stopped during the run, so it wasn't counted. Start Docker Desktop.")).toBe('docker');
    expect(infra("The container runtime failed during the run, so it wasn't counted. Run `codemm doctor`, then retry.")).toBe('docker');
    expect(infra('Docker is running Windows containers. Switch Docker Desktop to Linux containers and retry.')).toBe('docker');
    // Recorded in the macOS journey: the Docker CLI found couldn't reach Docker Desktop's credential helper.
    expect(infra('Gate "build" failed: the image didn\'t build:\n#2 ERROR: error getting credentials - err: exec: "docker-credential-osxkeychain": executable file not found in $PATH, out: ``')).toBe('docker');
    expect(infra('the image didn\'t build:\nnpm ERR! 404')).toBeNull();
  });
});
