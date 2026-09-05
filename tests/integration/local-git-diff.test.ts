import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalGitDiff } from '../../src/adapters/git/local-git-diff.js';

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
  root = await mkdtemp(join(tmpdir(), 'coverage-review-git-'));
  await git('init', '-q');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await writeFile(join(root, 'modify.ts'), 'before\n');
  await writeFile(join(root, 'remove.ts'), 'removed\n');
  await writeFile(join(root, 'old.ts'), 'unique rename content\n');
  await git('add', '.');
  await git('commit', '-qm', 'Base');
  base = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'modify.ts'), 'after\n');
  await rm(join(root, 'remove.ts'));
  await rename(join(root, 'old.ts'), join(root, 'renamed.ts'));
  await writeFile(join(root, 'new\tfile.ts'), 'new behavior\n');
  await writeFile(join(root, 'literal[1].ts'), 'literal\n');
  await writeFile(join(root, 'literal1.ts'), 'other\n');
  await git('add', '.');
  await git('commit', '-qm', 'Head');
  head = await git('rev-parse', 'HEAD');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it('ignores inherited Git repository overrides and disables external diff helpers', async () => {
  await git('config', 'diff.external', '/does-not-exist');
  vi.stubEnv('GIT_DIR', '/does-not-exist');
  const provider = new LocalGitDiff(root);
  expect(await provider.getFileDiff(base, head, 'modify.ts')).toContain('+after');
});
it('discovers changes between commits independently of working-tree edits', async () => {
  await writeFile(join(root, 'modify.ts'), 'uncommitted\n');
  const provider = new LocalGitDiff(root);
  const comparison = await provider.compare(base, head);
  expect(comparison.files).toEqual(expect.arrayContaining([
    { path: 'modify.ts', status: 'modified' }, { path: 'remove.ts', status: 'deleted' },
    { path: 'renamed.ts', previousPath: 'old.ts', status: 'renamed' },
    { path: 'new\tfile.ts', status: 'added' },
  ]));
  const patch = await provider.getFileDiff(base, head, 'modify.ts');
  expect(patch).toContain('-before\n+after');
  expect(patch).not.toContain('uncommitted');
  expect((await provider.compare(head, head)).files).toEqual([]);
});
it('returns deletion and rename patches and treats pathspecs literally', async () => {
  const provider = new LocalGitDiff(root);
  expect(await provider.getFileDiff(base, head, 'remove.ts')).toContain('-removed');
  expect(await provider.getFileDiff(base, head, 'renamed.ts')).toContain('rename from old.ts');
  const patch = await provider.getFileDiff(base, head, 'literal[1].ts');
  expect(patch).toContain('+literal');
  expect(patch).not.toContain('+other');
});
it('rejects refs, missing commits, and files outside the comparison', async () => {
  const provider = new LocalGitDiff(root);
  await expect(provider.compare('--help', head)).rejects.toThrow('SHA');
  await expect(provider.compare('0'.repeat(40), head)).rejects.toThrow();
  await expect(provider.getFileDiff(base, head, 'missing.ts')).rejects.toThrow('not changed');
});
