import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LocalRepository } from '../../src/adapters/repository/local-repository.js';

const execute = promisify(execFile);
let root: string;
let base: string;
let head: string;
async function git(...args: string[]): Promise<string> {
  return (await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })).stdout.trim();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'coverage-review-repository-'));
  await git('init', '-q');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/value.ts'), 'base');
  await symlink('/outside/repository', join(root, 'src/link.ts'));
  await writeFile(join(root, 'deleted.ts'), 'base-only');
  await git('add', '.'); await git('commit', '-qm', 'Base'); base = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'src/value.ts'), 'head');
  await rm(join(root, 'deleted.ts'));
  await git('add', '.'); await git('commit', '-qm', 'Head'); head = await git('rev-parse', 'HEAD');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('reads head and base commit snapshots without consulting working-tree changes', async () => {
  await writeFile(join(root, 'src/value.ts'), 'uncommitted');
  await git('replace', head, base);
  const repository = new LocalRepository(root);
  expect(await repository.readSource(head, 'src/value.ts')).toEqual({ status: 'available', content: 'head' });
  expect(await repository.readSource(base, 'deleted.ts')).toEqual({ status: 'available', content: 'base-only' });
  expect(await repository.readSource(head, 'deleted.ts')).toMatchObject({ status: 'missing' });
  expect(await repository.listFiles(head)).toEqual({ status: 'available', paths: ['src/link.ts', 'src/value.ts'] });
  expect(await repository.readSource(base, 'src/link.ts')).toMatchObject({ status: 'unsupported' });
});

it('rejects unsafe paths and reports bounded and binary blobs', async () => {
  const repository = new LocalRepository(root, 3);
  await expect(repository.readSource(head, '../outside')).rejects.toThrow();
  expect(await repository.readSource(head, 'src/value.ts')).toMatchObject({ status: 'truncated' });
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  await git('add', '.'); await git('commit', '-qm', 'Binary');
  const binaryHead = await git('rev-parse', 'HEAD');
  expect(await repository.readSource(binaryHead, 'binary.dat')).toMatchObject({ status: 'binary' });
});

it('reports oversized tree listings as truncated', async () => {
  const result = await new LocalRepository(root, 1_048_576, 20_000, 5).listFiles(head);
  expect(result).toEqual({ status: 'truncated', paths: [], reason: 'Git tree listing exceeds 5 byte limit' });
});
