// @vitest-environment node
import { codemmApiContract } from './testing/contract';
import { live } from './testing/fakes';

codemmApiContract('live, over a fake core and fake agents', () => {
  const t = live();
  return { api: t.api, stopDocker: () => void (t.c.down = true) };
});
