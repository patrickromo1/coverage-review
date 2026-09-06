import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { encodeActionOutput } from '../../src/github/actions-output.js';
import { CiReviewArtifactSchema, validateArtifactProvenance } from '../../src/github/artifact.js';
import { resolveWorkspaceInput, writeAtomicWorkspaceJson } from '../../src/github/workspace-files.js';
import { ReviewLimitsSchema } from '../../src/agent/review-agent.js';

it('contains input and output paths and rejects symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-review-files-'));
  await writeFile(join(root, 'lcov.info'), 'TN:\n');
  expect(await resolveWorkspaceInput(root, 'lcov.info')).toBe(await realpath(join(root, 'lcov.info')));
  await symlink(join(root, 'lcov.info'), join(root, 'link.info'));
  await expect(resolveWorkspaceInput(root, 'link.info')).rejects.toThrow(/symbolic/);
  await expect(resolveWorkspaceInput(root, '../escape')).rejects.toThrow(/escapes/);
  await mkdir(join(root, 'out'));
  const output = await writeAtomicWorkspaceJson(root, 'out/result.json', { ok: true });
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ ok: true });
  await expect(writeAtomicWorkspaceJson(root, '../result.json', {})).rejects.toThrow(/escapes/);
});

it('uses fixed output keys and rejects output injection', () => {
  expect(encodeActionOutput('verdict', 'adequate')).toBe('verdict=adequate\n');
  expect(() => encodeActionOutput('verdict', 'adequate\nevil=value')).toThrow(/single line/);
});

it('validates artifact identity and commit provenance', () => {
  const sha = 'b'.repeat(40);
  const artifact = CiReviewArtifactSchema.parse({ schemaVersion: '1', kind: 'coverage-review-result',
    context: { kind: 'pull-request', eventName: 'pull_request', owner: 'octo', repository: 'repo', repositorySlug: 'octo/repo', pullRequestNumber: 2, baseSha: 'a'.repeat(40), headSha: sha, fork: false, safeToAnalyze: true },
    comparisonBaseSha: 'a'.repeat(40), publishing: { status: 'not-requested' },
    review: { schemaVersion: '1', summary: 'done', findings: [], verdict: 'needs-review', analysisStatus: 'failed',
      scope: { baseSha: 'a'.repeat(40), headSha: sha, resolved: false, changedFiles: [], reviewedFiles: [] }, limitations: [{ code: 'agent-incomplete', message: 'skipped' }], rejectedFindings: [], evidenceReferences: [],
      provenance: { executorVersion: '1', policyVersion: '1', evidenceSchemaVersion: '1', agentMode: 'none', executionMode: 'github', limits: ReviewLimitsSchema.parse({}) } } });
  expect(validateArtifactProvenance(artifact, { repositorySlug: 'octo/repo', eventName: 'pull_request', pullRequestNumber: 2, headSha: sha })).toEqual(artifact);
  expect(() => validateArtifactProvenance(artifact, { repositorySlug: 'evil/repo', eventName: 'pull_request', pullRequestNumber: 2, headSha: sha })).toThrow(/provenance/);
});
