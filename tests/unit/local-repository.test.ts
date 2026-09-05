import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LocalRepository } from '../../src/adapters/repository/local-repository.js';

let temp: string;
let root: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'coverage-review-fs-'));
  root = join(temp, 'repo');
  await mkdir(root);
  await writeFile(join(root, 'source.ts'), 'hello');
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
it('reads files and internal symlinks', async () => {
  await symlink(join(root, 'source.ts'), join(root, 'alias.ts'));
  const repo = new LocalRepository(root);
  expect(await repo.readSource('source.ts')).toBe('hello');
  expect(await repo.readSource('alias.ts')).toBe('hello');
});
it.each(['../outside', '/etc/passwd', 'a/../../outside', 'C:\\secret', 'a\0b'])(
  'rejects unsafe paths %j', async (path) => {
    await expect(new LocalRepository(root).readSource(path)).rejects.toThrow();
  },
);
it('rejects escaping symlinks, directories, missing files, and oversized reads', async () => {
  await writeFile(join(temp, 'outside'), 'secret');
  await symlink(join(temp, 'outside'), join(root, 'escape'));
  await mkdir(join(root, 'directory'));
  const repo = new LocalRepository(root, 4);
  await expect(repo.readSource('escape')).rejects.toThrow('escapes');
  await expect(repo.readSource('directory')).rejects.toThrow('regular file');
  await expect(repo.readSource('missing')).rejects.toThrow();
  await expect(repo.readSource('source.ts')).rejects.toThrow('limit');
});
