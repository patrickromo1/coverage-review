import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { captureLocalReview } from '../../src/adapters/repository/local-snapshot.js';
import { executeReview } from '../../src/core/review/execute-review.js';
import { dependencies, proposal } from '../helpers/review.js';
import { parseUnifiedDiff } from '../../src/core/diff/structured-diff.js';
import { LcovCoverageProvider } from '../../src/adapters/coverage/lcov-coverage-provider.js';
const execute = promisify(execFile);
let root: string;
async function git(...args: string[]) { return (await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root })).stdout.trim(); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'coverage-local-test-'));
  await git('init', '-q'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'Fixture');
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n'); await git('add', '.'); await git('commit', '-qm', 'base');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('isolates partial staging and never changes index/worktree; excludes untracked files', async () => {
  const head = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'a.ts'), 'export const a = 2;\n'); await git('add', 'a.ts');
  await writeFile(join(root, 'a.ts'), 'export const a = 3;\n'); await writeFile(join(root, 'untracked.ts'), 'secret');
  const index = await readFile(join(root, '.git/index'));
  const staged = await captureLocalReview(root, 'staged'); const unstaged = await captureLocalReview(root, 'unstaged');
  expect(staged.baseSha).toBe(head); expect(staged.headSha).toMatch(/^local:/); expect(unstaged.baseSha).toBe(staged.headSha);
  expect(await staged.repository.readSource(staged.headSha, 'a.ts')).toMatchObject({ content: 'export const a = 2;\n' });
  expect(await unstaged.repository.readSource(unstaged.headSha, 'a.ts')).toMatchObject({ content: 'export const a = 3;\n' });
  expect((await unstaged.repository.listFiles(unstaged.headSha)).paths).not.toContain('untracked.ts');
  await writeFile(join(root, 'a.ts'), 'later edit');
  expect(await unstaged.repository.readSource(unstaged.headSha, 'a.ts')).toMatchObject({ content: 'export const a = 3;\n' });
  expect(await readFile(join(root, '.git/index'))).toEqual(index);
  expect(await git('rev-parse', 'HEAD')).toBe(head);
  await expect(staged.repository.readSource(head, '../escape')).rejects.toThrow();
});
it('binds local evidence and freshness through the shared executor', async () => {
  const head = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(root, 'coverage.info'), 'SF:a.ts\nDA:1,1\nend_of_record\n');
  const deps = { ...dependencies(), captureLocal: (mode: 'staged' | 'unstaged', signal: AbortSignal) => captureLocalReview(root, mode, signal), coverage: new LcovCoverageProvider(root, join(root, 'coverage.info'), head) };
  const result = await executeReview('uncaptured-base', 'uncaptured-head', deps, { mode: 'scripted', propose: async (request) => {
    expect(request.evidence.coverageReport.provenance?.freshness).toBe('unverifiable');
    return proposal(request, true);
  } }, { reviewMode: 'unstaged' });
  expect(result.schemaVersion).toBe('2'); expect(result.provenance.snapshotMode).toBe('unstaged');
  expect(result.verdict).toBe('needs-tests'); expect(result.findings).toHaveLength(1);
  expect(result.evidenceReferences.every((ref) => ref.id.startsWith('ev2:'))).toBe(true);
  await expect(executeReview('base', 'head', deps, { mode: 'scripted', propose: async (request) => proposal(request) }, { reviewMode: 'staged', executionMode: 'github' })).rejects.toThrow();
});
it('preserves exact rename base semantics, deletions and binary states', async () => {
  await git('mv', 'a.ts', 'renamed.ts');
  const staged = await captureLocalReview(root, 'staged');
  expect((await staged.diff.compare(staged.baseSha, staged.headSha)).files).toEqual([{ path: 'renamed.ts', previousPath: 'a.ts', status: 'renamed' }]);
  await rm(join(root, 'renamed.ts'));
  const deleted = await captureLocalReview(root, 'unstaged');
  const file = (await deleted.diff.compare(deleted.baseSha, deleted.headSha)).files[0]!;
  expect(file.status).toBe('deleted');
  const patch = parseUnifiedDiff(await deleted.diff.getFileDiff(deleted.baseSha, deleted.headSha, file.path), file);
  expect(patch.baseChangedLines).toEqual([{ start: 1, end: 1 }]); expect(patch.headChangedLines).toEqual([]);
  await writeFile(join(root, 'renamed.ts'), Buffer.from([0, 1]));
  const binary = await captureLocalReview(root, 'unstaged');
  expect(await binary.repository.readSource(binary.headSha, 'renamed.ts')).toMatchObject({ status: 'binary' });
});
it('rejects unsafe tracked working-tree symlinks and oversized files', async () => {
  await rm(join(root, 'a.ts')); await symlink('/etc/passwd', join(root, 'a.ts'));
  await expect(captureLocalReview(root, 'unstaged')).rejects.toThrow('capture failed');
  await rm(join(root, 'a.ts')); await writeFile(join(root, 'a.ts'), 'x'.repeat(32769));
  await expect(captureLocalReview(root, 'unstaged')).rejects.toThrow();
});
it('preserves staged symlinks as unsupported without following targets', async () => {
  await symlink('/etc/passwd', join(root, 'link.ts')); await git('add', 'link.ts');
  const captured = await captureLocalReview(root, 'staged');
  expect(await captured.repository.readSource(captured.headSha, 'link.ts')).toMatchObject({ status: 'unsupported' });
  await expect(captured.diff.getFileDiff(captured.baseSha, captured.headSha, 'link.ts')).rejects.toThrow('unavailable');
});
it('retries a concurrent edit once and rejects continuously changing captures', async () => {
  let calls = 0;
  const captured = await captureLocalReview(root, 'unstaged', undefined, async () => { if (calls++ === 0) await writeFile(join(root, 'a.ts'), 'changed\n'); });
  expect(calls).toBe(2); expect(await captured.repository.readSource(captured.headSha, 'a.ts')).toMatchObject({ content: 'changed\n' });
  await expect(captureLocalReview(root, 'unstaged', undefined, async () => { await writeFile(join(root, 'a.ts'), `edit ${calls++}\n`); })).rejects.toThrow('Concurrent');
});
it('fails unresolved index conflicts and cancellation without scheduling analysis', async () => {
  await git('checkout', '-qb', 'other'); await writeFile(join(root, 'a.ts'), 'other\n'); await git('commit', '-qam', 'other');
  await git('checkout', '-q', '-'); await writeFile(join(root, 'a.ts'), 'current\n'); await git('commit', '-qam', 'current');
  await git('merge', 'other').catch(() => undefined);
  await expect(captureLocalReview(root, 'staged')).rejects.toThrow('conflicts');
  await expect(captureLocalReview(root, 'unstaged', AbortSignal.abort())).rejects.toThrow();
});
it('runs the actual local CLI entrypoint with a captured snapshot', async () => {
  await writeFile(join(root, 'a.ts'), 'export const a = 2;\n');
  const { resolve } = await import('node:path');
  const result = await execute(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), '--repo', root, '--unstaged', '--offline-review', resolve('evals/fixtures/review/empty-proposal.json'), '--json'], { cwd: process.cwd() });
  const review = JSON.parse(result.stdout) as { schemaVersion: string; scope: { headSha: string; changedFiles: string[] }; verdict: string };
  expect(review.schemaVersion).toBe('2'); expect(review.scope.headSha).toMatch(/^local:/);
  expect(review.scope.changedFiles).toEqual(['a.ts']); expect(review.verdict).toBe('needs-review');
});
