import { expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import type { DiffProvider } from '../../src/core/diff/diff-provider.js';

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
