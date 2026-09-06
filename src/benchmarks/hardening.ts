import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { LocalGitDiff } from '../adapters/git/local-git-diff.js';
import { LocalRepository } from '../adapters/repository/local-repository.js';
import { ReviewRepository } from '../core/repository/review-repository.js';
const execute = promisify(execFile);
const fixture = z.object({ packages: z.number().int().min(1).max(20), filesPerPackage: z.number().int().min(1).max(20), testFilesPerPackage: z.number().int().min(1).max(20) }).parse(JSON.parse(await readFile('evals/fixtures/hardening/large-monorepo.json', 'utf8')));
const root = await mkdtemp(join(tmpdir(), 'coverage-hardening-benchmark-'));
const git = async (...args: string[]) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root })).stdout.trim();
try {
  await git('init', '-q'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'Fixture');
  const paths: string[] = [];
  for (let pkg = 0; pkg < fixture.packages; pkg++) {
    const dir = `packages/p${String(pkg).padStart(2, '0')}`; await mkdir(join(root, dir), { recursive: true });
    for (let file = 0; file < fixture.filesPerPackage; file++) {
      const path = `${dir}/value${String(file).padStart(2, '0')}.ts`; paths.push(path); await writeFile(join(root, path), 'export const value = 1;\n');
    }
    for (let test = 0; test < fixture.testFilesPerPackage; test++) await writeFile(join(root, `${dir}/value${String(test).padStart(2, '0')}.test.ts`), "// Static fixture; never execute.\nthrow new Error('DO_NOT_EXECUTE');\n");
  }
  await git('add', '.'); await git('commit', '-qm', 'base'); const base = await git('rev-parse', 'HEAD');
  for (const path of paths) await writeFile(join(root, path), 'export const value = 2;\n');
  await git('add', '.'); await git('commit', '-qm', 'head'); const head = await git('rev-parse', 'HEAD');
  const results = [];
  for (const cached of [false, true]) {
    const start = performance.now(); let requests = 0; let outputBytes = 0; let comparisons = 0;
    const shared = new LocalGitDiff(root);
    await shared.compare(base, head);
    if (!cached) { requests += shared.stats().requests; outputBytes += shared.stats().bytes; comparisons += shared.stats().comparisons; }
    for (const path of paths) {
      // Fresh adapters reproduce the milestone-5 repeated comparison path exactly.
      const adapter = cached ? shared : new LocalGitDiff(root);
      await adapter.getFileDiff(base, head, path);
      if (!cached) { requests += adapter.stats().requests; outputBytes += adapter.stats().bytes; comparisons += adapter.stats().comparisons; }
    }
    if (cached) { requests = shared.stats().requests; outputBytes = shared.stats().bytes; comparisons = shared.stats().comparisons; }
    const repository = new ReviewRepository(new LocalRepository(root), [base, head]);
    let reads = 0; let bytes = 0;
    for (let pass = 0; pass < 2; pass++) for (const path of paths) {
      if (cached) await repository.readSource(head, path);
      else { const value = await new LocalRepository(root).readSource(head, path); reads++; if (value.status === 'available') bytes += Buffer.byteLength(value.content); }
    }
    const listing = await repository.listFiles(head);
    results.push({ mode: cached ? 'cached' : 'uncached-milestone-5-equivalent', changedFiles: paths.length, filesScanned: listing.paths.length,
      diffGitRequests: requests, diffOutputBytes: outputBytes, comparisons, sourceReads: cached ? repository.stats().reads : reads,
      sourceBytes: cached ? repository.stats().readBytes : bytes, repeatedReads: cached ? 0 : paths.length,
      toolCalls: 0, elapsedMs: Math.round(performance.now() - start), rssBytes: process.memoryUsage().rss });
  }
  assert.equal(results[0]!.diffGitRequests, 3 + paths.length * 4);
  assert.equal(results[1]!.diffGitRequests, 3 + paths.length);
  assert.equal(results[1]!.sourceReads * 2, results[0]!.sourceReads);
  process.stdout.write(`${JSON.stringify({ benchmarkVersion: '1', network: false, repositoryCodeExecuted: false, results }, null, 2)}\n`);
} finally { await rm(root, { recursive: true, force: true }); }
