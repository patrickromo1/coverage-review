import { expect, it, vi } from 'vitest';
import { ReviewRepository } from '../../src/core/repository/review-repository.js';
import { discoveryListing } from '../../src/core/repository/repository.js';
import { ReviewConfigSchema } from '../../src/core/config/review-config.js';
import { SupportedTestDiscovery } from '../../src/core/test-discovery/supported-test-discovery.js';
import { parseCoveragePy } from '../../src/core/coverage/parse-coverage-py.js';
import { executeReview } from '../../src/core/review/execute-review.js';
import { dependencies, proposal } from '../helpers/review.js';
import { ReviewResultSchema } from '../../src/core/review/result.js';
import { ReviewTrace } from '../../src/core/review/trace.js';

it('orders pages, binds cursors to snapshot/query/size and retains incomplete enumeration', async () => {
  const underlying = { listFiles: vi.fn(async () => ({ status: 'truncated' as const, paths: ['z.ts', 'a.ts', 'b.ts'] })), readSource: vi.fn() };
  const repository = new ReviewRepository(underlying, ['base', 'head']);
  const first = await repository.page({ snapshot: 'head', size: 2 });
  expect(first.paths).toEqual(['a.ts', 'b.ts']);
  expect((await repository.page({ snapshot: 'head', size: 2, cursor: first.nextCursor! })).paths).toEqual(['z.ts']);
  for (const query of [{ snapshot: 'base', size: 2 }, { snapshot: 'head', size: 1 }, { snapshot: 'head', size: 2, prefix: 'a.ts' }]) {
    await expect(repository.page({ ...query, cursor: first.nextCursor! })).rejects.toThrow();
  }
  for (const cursor of ['garbage', first.nextCursor!.replace(/:2$/, ':999')]) await expect(repository.page({ snapshot: 'head', size: 2, cursor })).rejects.toThrow();
  await expect(repository.page({ snapshot: 'head', prefix: '../escape' })).rejects.toThrow();
  expect((await discoveryListing(repository, 'head')).status).toBe('truncated');
  expect(underlying.listFiles).toHaveBeenCalledTimes(2);
});
it('bounds cumulative bytes, caches immutable reads, and refuses cancelled work', async () => {
  const underlying = { listFiles: vi.fn(), readSource: vi.fn(async () => ({ status: 'available' as const, content: 'hello' })) };
  const repository = new ReviewRepository(underlying, ['head'], { maxReadBytes: 1024, maxFileBytes: 1024 });
  await repository.readSource('head', 'a.ts'); await repository.readSource('head', 'a.ts');
  expect(underlying.readSource).toHaveBeenCalledTimes(1);
  expect(await repository.readSource('head', 'b.ts')).toMatchObject({ status: 'truncated' });
  await expect(repository.readSource('head', 'a.ts', AbortSignal.abort())).rejects.toThrow();
  await expect(repository.readSource('other', 'a.ts')).rejects.toThrow();
  expect(repository.stats()).toMatchObject({ reads: 1, cacheHits: 1, reservedBytes: 1024, readBytes: 5 });
});
it('limits concurrent adapter scheduling', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const underlying = { listFiles: vi.fn(), readSource: vi.fn(async () => { await wait; return { status: 'available' as const, content: '' }; }) };
  const repository = new ReviewRepository(underlying, ['head']);
  const pending = Array.from({ length: 5 }, (_, index) => repository.readSource('head', `${index}.ts`));
  expect(underlying.readSource).toHaveBeenCalledTimes(4);
  release();
  expect((await Promise.all(pending))[4]).toMatchObject({ status: 'truncated' });
});
it('keeps a 501-file review partial and exposes omitted file status', async () => {
  const deps = dependencies(); const files = Array.from({ length: 501 }, (_, n) => ({ path: `${n}.ts`, status: 'modified' as const }));
  deps.diff.compare = async () => ({ baseSha: 'base', headSha: 'head', files });
  const read = vi.fn(deps.repository.readSource); deps.repository.readSource = read;
  const result = await executeReview('base', 'head', deps, { mode: 'scripted', propose: async (request) => { expect(request.evidence.files[500]?.source.status).toBe('truncated'); return proposal(request); } });
  expect(result.analysisStatus).toBe('partial'); expect(result.verdict).toBe('needs-review');
  expect(result.scope.changedFiles).toHaveLength(501); expect(read).toHaveBeenCalledTimes(500);
});
it('rejects ambiguous and unsafe monorepo configuration and cannot configure privileges', () => {
  for (const config of [
    { packages: [{ root: 'p', sourceRoots: ['elsewhere'] }] },
    { packages: [{ root: 'p', sourceRoots: ['p'] }, { root: 'p/sub', sourceRoots: ['p/sub'] }] },
    { reports: [{ path: '../coverage', format: 'lcov' }] }, { endpoint: 'https://evil.invalid' },
  ]) expect(ReviewConfigSchema.safeParse({ schemaVersion: '1', ...config }).success).toBe(false);
});
it('separates package basename hints while preserving static cross-package relationships and Python uncertainty', async () => {
  const config = ReviewConfigSchema.parse({ schemaVersion: '1', packages: [
    { root: 'a', sourceRoots: ['a/src'] }, { root: 'b', sourceRoots: ['b/src'] },
  ] });
  const contents: Record<string, string> = {
    'a/tests/unit/value.test.ts': "import { value } from '../../../b/src/value.ts';",
    'a/tests/unit/test_value.py': 'from value import calculate\nfrom .helper import thing\n',
  };
  const result = await new SupportedTestDiscovery(config).discover({ headSha: 'head', sourcePaths: ['a/src/value.ts', 'b/src/value.ts', 'a/src/value.py', 'b/src/value.py'],
    repository: { listFiles: async () => ({ status: 'available', paths: Object.keys(contents) }), readSource: async (_sha, path) => ({ status: 'available', content: contents[path]! }) } });
  const ts = result.candidates.find((candidate) => candidate.path.endsWith('.ts'))!;
  expect(ts.relationships).toContainEqual({ type: 'static-import', sourcePath: 'b/src/value.ts' });
  expect(ts.relationships).not.toContainEqual({ type: 'matching-name', sourcePath: 'b/src/value.ts' });
  const py = result.candidates.find((candidate) => candidate.path.endsWith('.py'))!;
  expect(py.level).toBe('unit'); expect(py.uncertainty).toContain('Ambiguous Python module mapping');
  expect(py.uncertainty.some((value) => value.includes('Unsupported Python'))).toBe(true);
});
it('parses Coverage.py format 3, distinguishes missing and zero, and rejects malformed/nested data', () => {
  const value = { meta: { format: 3, branch_coverage: true }, files: { 'value.py': { executed_lines: [1], missing_lines: [2], excluded_lines: [3], executed_branches: [[1, 2]], missing_branches: [[1, -1]] } } };
  const report = parseCoveragePy(JSON.stringify(value));
  expect(report.files[0]?.lines).toEqual([{ line: 1, hits: 1, covered: true }, { line: 2, hits: 0, covered: false }]);
  expect(report.files[0]?.branches.map((branch) => branch.hits).sort()).toEqual([0, 1]);
  for (const invalid of [{ ...value, meta: { format: 4 } }, { ...value, files: { '../outside': value.files['value.py'] } }, { ...value, files: { 'value.py': { ...value.files['value.py'], missing_lines: [1] } } }]) expect(() => parseCoveragePy(JSON.stringify(invalid))).toThrow();
  expect(() => parseCoveragePy('['.repeat(17) + ']'.repeat(17))).toThrow('nesting');
});
it('rejects local identities in v1 results and exports only deterministic metadata', async () => {
  const result = await executeReview('base', 'head', dependencies(), { mode: 'scripted', propose: async (request) => proposal(request) });
  expect(ReviewResultSchema.safeParse({ ...result, scope: { ...result.scope, headSha: `local:${'a'.repeat(64)}` } }).success).toBe(false);
  const exporter = vi.fn(); const trace = new ReviewTrace({ exportSpan: exporter, now: () => 100 });
  await trace.emit('collection', 90, 'partial', { reads: 2, truncated: 1 }, 'SECRET_SOURCE');
  expect(exporter.mock.calls[0]?.[0].durationMs).toBe(10); expect(JSON.stringify(exporter.mock.calls)).not.toContain('SECRET');
});

it('does not allow duplicate JSON keys to overwrite report evidence', async () => {
  const { parseBoundedJson } = await import('../../src/core/coverage/bounded-json.js');
  expect(() => parseBoundedJson('{"files":{"value.py":{},"value.py":{}}}')).toThrow('Duplicate');
  expect(() => parseBoundedJson('{"a":1,"\\u0061":2}')).toThrow('Duplicate');
});
it('validates incompatible local/config flags before constructing providers or evidence', async () => {
  const { runCli } = await import('../../src/cli/run.js');
  const diff = vi.fn(); const evidence = vi.fn();
  for (const flags of [
    ['--staged', '--unstaged'], ['--staged', '--base', 'a', '--head', 'b', '--offline-review', 'p.json'],
    ['--unstaged', '--evidence'], ['--staged', '--review', '--provider', 'other', '--model', 'mock'],
    ['--base', 'a', '--head', 'b', '--config', 'c.json', '--lcov', 'l.info', '--evidence'],
  ]) await expect(runCli(flags, diff, evidence)).rejects.toThrow();
  expect(diff).not.toHaveBeenCalled(); expect(evidence).not.toHaveBeenCalled();
  expect(await runCli(['--help'], diff)).toContain('--unstaged');
});
it('stops collection scheduling after a cancelled discovery adapter', async () => {
  const deps = dependencies(); let seen: AbortSignal | undefined;
  deps.testDiscovery.discover = async (request) => { seen = request.signal; await new Promise((resolve) => request.signal!.addEventListener('abort', resolve, { once: true })); throw new Error('Cancelled'); };
  const coverage = vi.fn(deps.coverage.getCoverage); deps.coverage.getCoverage = coverage;
  const result = await executeReview('base', 'head', deps, { mode: 'scripted', propose: vi.fn() }, { timeoutMs: 10 });
  expect(seen?.aborted).toBe(true); expect(coverage).not.toHaveBeenCalled(); expect(result.analysisStatus).toBe('failed');
});
it('rejects local results in CI artifacts even if execution metadata is relabeled', async () => {
  const { CiReviewArtifactSchema } = await import('../../src/github/artifact.js');
  const { loadSemanticSuite, runSemanticSuite } = await import('../../src/evals/run-semantic.js');
  const suite = await loadSemanticSuite();
  const run = await runSemanticSuite(suite, { ids: ['local-freshness'], repeats: 1, concurrency: 1, mode: 'offline' });
  const review = run.cases[0]!.result;
  expect(CiReviewArtifactSchema.safeParse({ schemaVersion: '1', kind: 'coverage-review-result',
    context: { kind: 'pull-request', eventName: 'pull_request', owner: 'octo', repository: 'repo', repositorySlug: 'octo/repo', pullRequestNumber: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), fork: false, safeToAnalyze: true },
    comparisonBaseSha: 'a'.repeat(40), review: { ...review, provenance: { ...review.provenance, executionMode: 'github' } }, publishing: { status: 'not-requested' },
  }).success).toBe(false);
});
it('bounds same-directory relationship fan-out and retains truncation', async () => {
  const { TypeScriptTestDiscovery } = await import('../../src/core/test-discovery/typescript-test-discovery.js');
  const result = await new TypeScriptTestDiscovery().discover({ headSha: 'head', sourcePaths: Array.from({ length: 1100 }, (_, n) => `src/${n}.ts`),
    repository: { listFiles: async () => ({ status: 'available', paths: ['src/all.test.ts'] }), readSource: async () => ({ status: 'available', content: '' }) } });
  expect(result.status).toBe('truncated');
  expect(result.candidates[0]?.relationships.length).toBeLessThanOrEqual(100);
  expect(result.diagnostics).toContain('Discovery source-path budget exhausted');
});
