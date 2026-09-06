import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { runGitHubAction } from '../../src/github/run.js';
import type { GitHubClient } from '../../src/github/domain.js';

const execute = promisify(execFile);
async function git(root: string, ...args: string[]) { return (await execute('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim(); }

it('runs Actions mode through the shared executor and writes safe outputs/artifact without network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-review-action-'));
  await git(root, 'init'); await git(root, 'config', 'user.email', 'test@example.com'); await git(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n'); await git(root, 'add', 'a.ts'); await git(root, 'commit', '-m', 'base');
  const base = await git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'a.ts'), 'export const a = 2;\n'); await git(root, 'commit', '-am', 'head');
  const head = await git(root, 'rev-parse', 'HEAD');
  const event = join(root, 'event.json'); const output = join(root, 'outputs.txt');
  await writeFile(event, JSON.stringify({ repository: { full_name: 'octo/repo', name: 'repo', owner: { login: 'octo' } }, number: 8,
    pull_request: { base: { sha: base, repo: { full_name: 'octo/repo' } }, head: { sha: head, repo: { full_name: 'octo/repo' } } } }));
  await writeFile(join(root, 'proposal.json'), JSON.stringify({ schemaVersion: '1', summary: 'offline', analysisStatus: 'complete', reviewedFiles: ['a.ts'], limitations: [], findings: [] }));
  const client: GitHubClient = {
    getPullRequest: vi.fn(async () => ({ number: 8, baseSha: base, headSha: head, baseRepository: 'octo/repo', headRepository: 'octo/repo' })),
    compareCommits: vi.fn(async () => ({ baseSha: base, headSha: head, mergeBaseSha: base })),
    createCheckRun: vi.fn(async () => ({ id: 1 })), updateCheckRun: vi.fn(async () => undefined),
  };
  const artifact = await runGitHubAction(['--offline-review', 'proposal.json'], {
    GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'octo/repo', GITHUB_OUTPUT: output,
  }, { client });
  if ('help' in artifact) throw new Error('Unexpected help result');
  expect(artifact.review.provenance).toMatchObject({ agentMode: 'scripted', executionMode: 'github' });
  expect(artifact.review).toMatchObject({ verdict: 'needs-review', analysisStatus: 'partial', scope: { baseSha: base, headSha: head, resolved: true } });
  const persisted = JSON.parse(await readFile(join(root, 'coverage-review-result.json'), 'utf8')) as unknown;
  expect(persisted).toEqual(artifact);
  const outputs = await readFile(output, 'utf8');
  expect(outputs).toContain(`reviewed-base-sha=${base}\n`); expect(outputs).not.toContain('offline');
  const missingToken = await runGitHubAction(['--offline-review', 'proposal.json', '--publish-check', '--result', 'publish.json'], {
    GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'octo/repo',
  }, { resolveMergeBase: async () => base });
  if ('help' in missingToken) throw new Error('Unexpected help result');
  expect(missingToken.publishing).toEqual({ status: 'failed', reason: 'missing-token' });
  expect(missingToken.review.verdict).toBe('needs-review');
});

it('skips unsafe target and fork-live contexts before clients or providers run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-review-action-skip-')); const event = join(root, 'event.json');
  const base = 'a'.repeat(40); const head = 'b'.repeat(40);
  await writeFile(event, JSON.stringify({ repository: { full_name: 'octo/repo', name: 'repo', owner: { login: 'octo' } }, number: 1,
    pull_request: { base: { sha: base, repo: { full_name: 'octo/repo' } }, head: { sha: head, repo: { full_name: 'fork/repo' } } } }));
  const client = { getPullRequest: vi.fn(), compareCommits: vi.fn(), createCheckRun: vi.fn(), updateCheckRun: vi.fn() } as unknown as GitHubClient;
  const target = await runGitHubAction(['--review', '--provider', 'openai', '--model', 'model'], {
    GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REPOSITORY: 'octo/repo', OPENAI_API_KEY: 'SECRET',
  }, { client });
  if ('help' in target) throw new Error('Unexpected help result');
  expect(target.review).toMatchObject({ verdict: 'needs-review', analysisStatus: 'failed', provenance: { agentMode: 'none' } });
  expect(client.getPullRequest).not.toHaveBeenCalled();
  const fork = await runGitHubAction(['--review', '--provider', 'openai', '--model', 'model', '--result', 'fork.json'], {
    GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'octo/repo', OPENAI_API_KEY: 'SECRET',
  }, { client });
  if ('help' in fork) throw new Error('Unexpected help result');
  expect(fork.review.provenance.agentMode).toBe('none'); expect(client.getPullRequest).not.toHaveBeenCalled();
  await writeFile(event, JSON.stringify({ repository: { full_name: 'octo/repo', name: 'repo', owner: { login: 'octo' } }, number: 1,
    pull_request: { base: { sha: base, repo: { full_name: 'octo/repo' } }, head: { sha: head, repo: { full_name: 'octo/repo' } } } }));
  const noSecret = await runGitHubAction(['--review', '--provider', 'openai', '--model', 'model', '--result', 'no-secret.json'], {
    GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'octo/repo',
  }, { resolveMergeBase: async () => base });
  if ('help' in noSecret) throw new Error('Unexpected help result');
  expect(noSecret.review).toMatchObject({ verdict: 'needs-review', analysisStatus: 'failed', provenance: { agentMode: 'none' } });
});
