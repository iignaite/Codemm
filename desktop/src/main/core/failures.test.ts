// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { INFRA, infraError, type InfraCode } from '../../../../src/errors';
import { infra, infraOf, needsRebuild } from './failures';

const told: Record<InfraCode, string> = {
  'no-runtime': 'docker',
  'no-wasmtime': 'docker-failed',
  'runtime-down': 'docker',
  'runtime-paused': 'docker',
  'socket-permission': 'docker',
  'runtime-context': 'docker',
  'runtime-busy': 'docker-busy',
  'check-timeout': 'docker-busy',
  'container-remove': 'docker-busy',
  'windows-containers': 'docker-failed',
  credentials: 'docker-failed',
  'container-start': 'docker-failed',
  'docker-cpus': 'docker-failed',
  'docker-log-driver': 'docker-failed',
  'docker-file-sharing': 'docker-failed',
  'runtime-failed': 'docker-failed',
  'image-id': 'docker-failed',
  'image-inspect': 'docker-failed',
  'container-list': 'docker-failed',
  'docker-disk': 'docker-disk',
  'host-disk': 'disk',
  offline: 'offline',
  'rate-limit': 'offline',
  tls: 'offline',
  'network-timeout': 'offline',
};

describe("core's failure codes (src/errors.ts INFRA)", () => {
  it.each(Object.keys(INFRA) as InfraCode[])('tells the learner what %s means, over MCP and in this process', (code) => {
    // Docker that is up (busy, or answering but failing) is never told it stopped.
    expect(infra(`codemm:${code}\nSome wording.`)).toEqual({ cause: code, infra: told[code] });
    expect(infraOf(infraError('Some wording.', code))).toEqual({ cause: code, infra: told[code] });
  });

  it("tells an inspect that failed while Docker answers (Docker 29's template error) apart from a stopped Docker", () => {
    const failed = infraError('The container runtime couldn\'t inspect the track image: template: :1:12: executing "" at <.Config.Volumes>: map has no entry for key "Volumes"', 'image-inspect');
    expect(infraOf(failed)).toEqual({ cause: 'image-inspect', infra: 'docker-failed' });
    expect(infra(`codemm:image-inspect\n${failed.message}`)).toEqual({ cause: 'image-inspect', infra: 'docker-failed' });
  });

  it('reads the code after words an agent put before it on the first line', () => {
    expect(infra('Error: codemm:runtime-busy\nThe container runtime isn\'t answering.')).toEqual({ cause: 'runtime-busy', infra: 'docker-busy' });
    expect(infra('<tool_use_error>codemm:docker-disk\nDocker ran out of disk space.</tool_use_error>')).toEqual({ cause: 'docker-disk', infra: 'docker-disk' });
  });

  it("reads nothing but core's code: not its wording, and not output a message quotes", () => {
    // Core's wording without its code, a program's stderr in a lesson example, a runner's output in a gate failure.
    expect(infra("The container runtime isn't running. Start Docker Desktop.")).toBeNull();
    expect(infra('Example 1 didn\'t run cleanly (exit 1):\nconnect: Network is unreachable\ncodemm:offline\n')).toBeNull();
    expect(infra('Gate "probe pass" failed: the io pass probe should pass every test:\nIt printed:\ncodemm:runtime-down\nCannot connect to the Docker daemon')).toBeNull();
    expect(infra('codemm:no-course\nNo course in this workspace yet.')).toBeNull();
    expect(infra('codemm:made-up\nx')).toBeNull();
  });

  it('tells a track image that needs a rebuild', () => {
    expect(needsRebuild('codemm:image-missing\nThe image for py@1 is missing or changed.')).toBe(true);
    expect(needsRebuild('The image for py@1 is missing or changed.')).toBe(false);
    expect(needsRebuild('Gate "build" failed:\nIt printed:\ncodemm:image-missing')).toBe(false);
  });
});

describe('errors core threw in this process', () => {
  const core = (message: string, kind?: string) => Object.assign(new Error(message), { name: 'CodemmError', ...(kind ? { kind } : {}) });

  it("keeps a kind without a code, Docker as stopped, and reads a write that ran out of space as this computer's disk", () => {
    expect(infraOf(core('Some wording', 'docker'))).toEqual({ cause: 'other', infra: 'docker' });
    expect(infraOf(core('Some wording', 'disk'))).toEqual({ cause: 'other', infra: 'disk' });
    expect(infraOf(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))).toEqual({ cause: 'host-disk', infra: 'disk' });
  });

  it("is no infrastructure failure without core's kind or code, whatever it says", () => {
    expect(infraOf(core("The container runtime isn't running."))).toBeNull();
    expect(infraOf(core('Reload the file.', 'changed'))).toBeNull();
    expect(infraOf(new Error("The container runtime isn't running."))).toBeNull();
    expect(infraOf(Object.assign(new Error('x'), { code: 'runtime-down' }))).toBeNull();
  });
});
