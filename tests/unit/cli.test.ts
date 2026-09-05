import { expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import type { DiffProvider } from '../../src/core/diff/diff-provider.js';
import type { EvidenceCollectorDependencies } from '../../src/core/evidence/collect-evidence.js';

const comparison = { baseSha: 'base', headSha: 'head', files: [{ path: 'a.ts', status: 'added' as const }] };
const provider: DiffProvider = {
  compare: vi.fn(async () => comparison),
  getFileDiff: vi.fn(async () => '+new\n'),
};
it('uses an injected provider for JSON and patch output', async () => {
  const create = vi.fn(() => provider);
  expect(JSON.parse(await runCli(['--base', 'base', '--head', 'head', '--repo', '/fixture'], create))).toEqual(comparison);
  expect(create).toHaveBeenCalledWith('/fixture');
  expect(await runCli(['--base', 'base', '--head', 'head', '--file', 'a.ts'], create)).toBe('+new\n');
  expect(provider.getFileDiff).toHaveBeenCalledWith('base', 'head', 'a.ts');
});
it('shows help without accessing a repository', async () => {
  const create = vi.fn(() => provider);
  expect(await runCli(['--help'], create)).toContain('Usage:');
  expect(create).not.toHaveBeenCalled();
});
it('rejects missing and unknown arguments', async () => {
  await expect(runCli([], () => provider)).rejects.toThrow('required');
  await expect(runCli(['--unknown'], () => provider)).rejects.toThrow();
});

it('supports explicit evidence output and validates option combinations', async () => {
  const dependencies: EvidenceCollectorDependencies = {
    diff: { compare: async () => ({ baseSha: 'base', headSha: 'head', files: [] }), getFileDiff: async () => '' },
    repository: { listFiles: async () => ({ status: 'available', paths: [] }), readSource: async () => ({ status: 'missing', reason: 'missing' }) },
    testDiscovery: { discover: async () => ({ status: 'available', candidates: [], diagnostics: [] }) },
    coverage: { getCoverage: async () => ({ status: 'unavailable', reason: 'No coverage report was provided' }) },
  };
  const createEvidence = vi.fn(() => dependencies);
  const result = JSON.parse(await runCli(['--base', 'base', '--head', 'head', '--repo', '/fixture', '--evidence', '--lcov', 'coverage/lcov.info', '--coverage-commit', 'head'], () => provider, createEvidence));
  expect(result.schemaVersion).toBe('1');
  expect(createEvidence).toHaveBeenCalledWith({ root: '/fixture', lcov: 'coverage/lcov.info', coverageCommit: 'head' });
  await expect(runCli(['--base', 'base', '--head', 'head', '--lcov', 'x'], () => provider)).rejects.toThrow('require --evidence');
  await expect(runCli(['--base', 'base', '--head', 'head', '--file', 'a', '--evidence'], () => provider)).rejects.toThrow('mutually exclusive');
});
