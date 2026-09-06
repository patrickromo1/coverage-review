import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LcovCoverageProvider } from '../../src/adapters/coverage/lcov-coverage-provider.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'coverage-review-lcov-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('tracks matching, stale, and unverifiable report provenance', async () => {
  const report = join(root, 'lcov.info');
  await writeFile(report, 'SF:src/a.ts\nDA:1,0\nend_of_record\n');
  expect((await new LcovCoverageProvider(root, report, 'head').getCoverage({ headSha: 'head' })).provenance?.freshness).toBe('matching');
  expect((await new LcovCoverageProvider(root, report, 'old').getCoverage({ headSha: 'head' })).provenance?.freshness).toBe('stale');
  expect((await new LcovCoverageProvider(root, report).getCoverage({ headSha: 'head' })).provenance?.freshness).toBe('unverifiable');
});

it('reports missing, malformed, and oversized coverage explicitly', async () => {
  expect((await new LcovCoverageProvider(root, join(root, 'missing')).getCoverage({ headSha: 'head' })).status).toBe('unavailable');
  const malformed = join(root, 'malformed.info');
  await writeFile(malformed, 'SF:src/a.ts\nDA:nope,0\nend_of_record\n');
  expect((await new LcovCoverageProvider(root, malformed).getCoverage({ headSha: 'head' })).status).toBe('unsupported');
  expect((await new LcovCoverageProvider(root, malformed, undefined, 2).getCoverage({ headSha: 'head' })).status).toBe('truncated');
  const link = join(root, 'link.info'); await symlink(malformed, link);
  expect(await new LcovCoverageProvider(root, link).getCoverage({ headSha: 'head' })).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('symbolic') });
  const directory = join(root, 'coverage'); await mkdir(directory);
  expect(await new LcovCoverageProvider(root, directory).getCoverage({ headSha: 'head' })).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('regular file') });
});
