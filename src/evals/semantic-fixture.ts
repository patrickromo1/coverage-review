import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EvidenceCollectorDependencies } from '../core/evidence/collect-evidence.js';
import { SupportedTestDiscovery } from '../core/test-discovery/supported-test-discovery.js';
import { assertRepositoryPath } from '../core/repository/repository.js';

export const SemanticFixtureSchema = z.strictObject({
  mode: z.enum(['staged', 'unstaged']).optional(),
  id: z.string().regex(/^[a-z0-9-]+$/), version: z.literal('1'),
  sourcePath: z.string(), before: z.string().max(100_000), after: z.string().max(100_000),
  tests: z.record(z.string(), z.string().max(100_000)),
  coverage: z.enum(['matching', 'missing', 'stale']), sourceTruncated: z.boolean(),
});
export type SemanticFixture = z.infer<typeof SemanticFixtureSchema>;

/** In-memory committed snapshots. Only these exact files/commits are readable; annotations are absent. */
export function semanticDependencies(raw: SemanticFixture): { baseSha: string; headSha: string; dependencies: EvidenceCollectorDependencies } {
  const fixture = SemanticFixtureSchema.parse(raw);
  for (const path of [fixture.sourcePath, ...Object.keys(fixture.tests)]) assertRepositoryPath(path);
  if (fixture.sourcePath in fixture.tests) throw new Error('Fixture test overlaps source');
  const before = { ...fixture.tests, [fixture.sourcePath]: fixture.before };
  const after = { ...fixture.tests, [fixture.sourcePath]: fixture.after };
  const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');
  const baseSha = fixture.mode === 'unstaged' ? `local:${createHash('sha256').update(JSON.stringify(before)).digest('hex')}` : hash(before);
  const headSha = fixture.mode ? `local:${createHash('sha256').update(JSON.stringify(after)).digest('hex')}` : hash(after);
  const lines = (value: string) => value.replace(/\n$/, '').split('\n');
  const oldLines = lines(fixture.before); const newLines = lines(fixture.after);
  const patch = `@@ -1,${oldLines.length} +1,${newLines.length} @@\n${oldLines.map((line) => `-${line}`).join('\n')}\n${newLines.map((line) => `+${line}`).join('\n')}\n`;
  const dependencies: EvidenceCollectorDependencies = {
    diff: {
      compare: async (base, head) => {
        if (base !== baseSha || head !== headSha) throw new Error('Unknown fixture comparison');
        return { baseSha, headSha, files: [{ path: fixture.sourcePath, status: 'modified' }] };
      },
      getFileDiff: async (base, head, path) => {
        if (base !== baseSha || head !== headSha || path !== fixture.sourcePath) throw new Error('Unknown fixture diff');
        return patch;
      },
    },
    repository: {
      listFiles: async (commit) => {
        if (commit !== baseSha && commit !== headSha) throw new Error('Unknown fixture commit');
        return { status: 'available', paths: Object.keys(commit === baseSha ? before : after) };
      },
      readSource: async (commit, path, signal, maxBytes = 100_000) => {
        signal?.throwIfAborted(); assertRepositoryPath(path);
        if (commit !== baseSha && commit !== headSha) throw new Error('Unknown fixture commit');
        if (fixture.sourceTruncated && path === fixture.sourcePath) return { status: 'truncated', reason: 'Fixture source read limit exceeded' };
        const content = (commit === baseSha ? before : after)[path];
        if (content !== undefined && Buffer.byteLength(content) > maxBytes) return { status: 'truncated', reason: 'Fixture source read limit exceeded' };
        return content === undefined ? { status: 'missing', reason: 'Not in fixture snapshot' } : { status: 'available', content };
      },
    },
    testDiscovery: new SupportedTestDiscovery(),
    coverage: { getCoverage: async () => fixture.coverage === 'missing' ? { status: 'unavailable', reason: 'No fixture coverage' } : {
      status: 'available', provenance: { format: 'lcov', reportPath: 'fixture.lcov', commitSha: fixture.coverage === 'stale' ? baseSha : headSha, freshness: fixture.coverage },
      diagnostics: [], files: [{ path: fixture.sourcePath, lines: newLines.map((_line, index) => ({ line: index + 1, hits: 1, covered: true })), branches: [] }],
    } },
  };
  return { baseSha, headSha, dependencies: fixture.mode ? { ...dependencies, captureLocal: async () => ({ baseSha, headSha, diff: dependencies.diff, repository: dependencies.repository }) } : dependencies };
}
