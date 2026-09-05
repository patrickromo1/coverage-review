import { expect, it } from 'vitest';
import type { CoverageProvider } from '../../src/core/coverage/coverage-provider.js';
import type { DiffProvider } from '../../src/core/diff/diff-provider.js';
import { collectEvidence } from '../../src/core/evidence/collect-evidence.js';
import type { Repository } from '../../src/core/repository/repository.js';
import type { TestDiscovery } from '../../src/core/test-discovery/test-discovery.js';

const diff: DiffProvider = {
  compare: async () => ({ baseSha: 'base-resolved', headSha: 'head-resolved', files: [
    { path: 'src/a.ts', status: 'modified' }, { path: 'gone.ts', status: 'deleted' },
  ] }),
  getFileDiff: async (_base, _head, path) => path === 'src/a.ts'
    ? '@@ -1,2 +1,2 @@\n export const a = 1;\n-// old\n+// cosmetic\n'
    : '@@ -1 +0,0 @@\n-export const gone = true;\n',
};
const reads: string[] = [];
const repository: Repository = {
  listFiles: async () => ({ status: 'available', paths: ['src/a.ts', 'src/a.test.ts'] }),
  readSource: async (commit, path) => {
    reads.push(`${commit}:${path}`);
    return { status: 'available', content: path.endsWith('.test.ts') ? "import './a.js'" : 'committed' };
  },
};
const discovery: TestDiscovery = {
  discover: async () => ({ status: 'available', diagnostics: [], candidates: [{
    path: 'src/a.test.ts', level: 'unknown', relationships: [{ type: 'static-import', sourcePath: 'src/a.ts' }],
    uncertainty: ['Does not prove assertions'],
  }] }),
};

it('combines changed lines, candidate tests, stale measured-zero coverage, and base reads for deletions', async () => {
  const coverage: CoverageProvider = { getCoverage: async () => ({
    status: 'available', diagnostics: ['stale'], provenance: { format: 'lcov', reportPath: '/tmp/lcov.info', commitSha: 'other', freshness: 'stale' },
    files: [{ path: 'src/a.ts', lines: [{ line: 2, hits: 0, covered: false }], branches: [] }],
  }) };
  const result = await collectEvidence('base', 'head', { diff, repository, testDiscovery: discovery, coverage });
  expect(result.schemaVersion).toBe('1');
  expect(result.files[0]?.coverage).toEqual({ status: 'measured', freshness: 'stale', lines: [{ line: 2, hits: 0, covered: false }], branches: [] });
  expect(result.files[0]?.candidateTests).toHaveLength(1);
  expect(result.files[1]?.coverage.status).toBe('not-applicable');
  expect(reads).toContain('head-resolved:src/a.ts');
  expect(reads).toContain('base-resolved:gone.ts');
});

it('distinguishes a missing report from a file missing in an available report', async () => {
  const unavailable: CoverageProvider = { getCoverage: async () => ({ status: 'unavailable', reason: 'No report' }) };
  const unknown = await collectEvidence('base', 'head', { diff, repository, testDiscovery: discovery, coverage: unavailable });
  expect(unknown.files[0]?.coverage).toEqual({ status: 'unknown', reason: 'No report' });
  const empty: CoverageProvider = { getCoverage: async () => ({ status: 'available', diagnostics: [], provenance: { format: 'lcov', reportPath: '/r', freshness: 'unverifiable' }, files: [] }) };
  const missing = await collectEvidence('base', 'head', { diff, repository, testDiscovery: discovery, coverage: empty });
  expect(missing.files[0]?.coverage.status).toBe('missing');
});
