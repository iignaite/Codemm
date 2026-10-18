// @vitest-environment node
import { createMock, type MockOptions } from './mock';
import { codemmApiContract } from './testing/contract';

codemmApiContract('the mock', () => {
  const options: MockOptions = {};
  return { api: createMock(options), stopDocker: () => void (options.docker = 'stopped') };
});
