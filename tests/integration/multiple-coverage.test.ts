import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MultipleCoverageProvider } from '../../src/adapters/coverage/multiple-coverage-provider.js';
let root: string;
const headSha = 'a'.repeat(40);
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'coverage-multiple-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('maps identical basenames without cross-association, preserves duplicate provenance, and makes overlap explicit', async () => {
  await writeFile(join(root, 'a.info'), 'SF:src/value.ts\nDA:1,0\nend_of_record\n');
  await writeFile(join(root, 'b.info'), 'SF:src/value.ts\nDA:1,2\nend_of_record\n');
  const a = { path: 'a.info', format: 'lcov' as const, root: 'packages/a', commitSha: headSha };
  const b = { path: 'b.info', format: 'lcov' as const, root: 'packages/b', commitSha: headSha };
  const result = await new MultipleCoverageProvider(root, [a, b, a]).getCoverage({ headSha });
  expect(result.status).toBe('available');
  if (result.status !== 'available') return;
  expect(result.files.map((file) => [file.path, file.lines[0]?.hits])).toEqual([['packages/a/src/value.ts', 0], ['packages/b/src/value.ts', 2]]);
  expect(result.reports).toHaveLength(3); expect(result.diagnostics).toEqual([]);
  const conflict = await new MultipleCoverageProvider(root, [a, { ...b, root: 'packages/a' }]).getCoverage({ headSha });
  expect(conflict.status === 'available' && conflict.diagnostics).toContain('Overlapping coverage measurements conflict');
});
it('never hides stale, malformed, unsafe or locally unverifiable reports behind a fresh one', async () => {
  await writeFile(join(root, 'fresh.info'), 'SF:a.ts\nDA:1,1\nend_of_record\n');
  await writeFile(join(root, 'bad.info'), 'MALFORMED'); await symlink('/etc/passwd', join(root, 'link.info'));
  const result = await new MultipleCoverageProvider(root, [
    { path: 'fresh.info', format: 'lcov', commitSha: headSha }, { path: 'fresh.info', format: 'lcov', commitSha: 'b'.repeat(40) },
    { path: 'bad.info', format: 'lcov' }, { path: 'link.info', format: 'lcov' },
  ]).getCoverage({ headSha });
  expect(result.status).toBe('available'); expect(result.provenance?.freshness).toBe('stale');
  expect(result.reports?.map((report) => report.status)).toEqual(['available', 'available', 'unsupported', 'unsupported']);
  expect(JSON.stringify(result)).not.toContain(root); expect(JSON.stringify(result)).not.toContain('/etc/passwd');
  const local = await new MultipleCoverageProvider(root, [{ path: 'fresh.info', format: 'lcov', commitSha: headSha }]).getCoverage({ headSha: `local:${'c'.repeat(64)}` });
  expect(local.provenance?.freshness).toBe('unverifiable');
});
it('bounds aggregate failed-read reservations and rejects symlink parent directories', async () => {
  await mkdir(join(root, 'real')); await symlink(join(root, 'real'), join(root, 'alias'));
  const result = await new MultipleCoverageProvider(root, [
    { path: 'alias/report', format: 'lcov' }, { path: 'missing', format: 'lcov' }, { path: 'third', format: 'lcov' },
  ]).getCoverage({ headSha });
  expect(result.status).toBe('truncated');
  expect(result.reports?.map((report) => report.status)).toEqual(['unsupported', 'unavailable', 'truncated']);
  await expect(new MultipleCoverageProvider(root, []).getCoverage({ headSha, signal: AbortSignal.abort() })).rejects.toThrow();
});
it('preserves unavailable and unsupported status when every configured report fails', async () => {
  const missing = await new MultipleCoverageProvider(root, [{ path: 'missing.info', format: 'lcov' }]).getCoverage({ headSha });
  expect(missing).toMatchObject({ status: 'unavailable', reason: 'All coverage reports were unavailable' });
  expect(missing.reports?.[0]).toMatchObject({ status: 'unavailable', diagnostics: ['Coverage input unavailable'] });
  await writeFile(join(root, 'bad.info'), 'MALFORMED');
  const malformed = await new MultipleCoverageProvider(root, [{ path: 'bad.info', format: 'lcov' }]).getCoverage({ headSha });
  expect(malformed).toMatchObject({ status: 'unsupported', reason: 'All coverage reports were invalid or unsafe' });
});
it('loads the checked-in Coverage.py fixture through CoverageProvider', async () => {
  const { readFile } = await import('node:fs/promises');
  await writeFile(join(root, 'coverage.json'), await readFile('evals/fixtures/hardening/python-coverage.json'));
  const result = await new MultipleCoverageProvider(root, [{ path: 'coverage.json', format: 'coverage-py-json', root: 'python/src', commitSha: headSha }]).getCoverage({ headSha });
  expect(result.status).toBe('available');
  if (result.status !== 'available') return;
  expect(result.files[0]?.path).toBe('python/src/value.py');
  expect(result.files[0]?.lines.find((line) => line.line === 3)?.hits).toBe(0);
  expect(result.reports?.[0]).toMatchObject({ format: 'coverage-py-json', root: 'python/src', freshness: 'matching', status: 'available' });
});
