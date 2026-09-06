import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { FullShaSchema, GitHubReviewContextSchema, RepositorySlugSchema, type GitHubReviewContext } from './domain.js';

const repository = z.object({ full_name: RepositorySlugSchema, name: z.string(), owner: z.object({ login: z.string() }) });
const pullRequest = z.object({
  number: z.number().int().positive().optional(),
  base: z.object({ sha: FullShaSchema, repo: z.object({ full_name: RepositorySlugSchema }) }),
  head: z.object({ sha: FullShaSchema, repo: z.object({ full_name: RepositorySlugSchema }) }),
});
const eventPayload = z.object({
  repository,
  number: z.number().int().positive().optional(),
  pull_request: pullRequest.optional(),
  merge_group: z.object({ base_sha: FullShaSchema, head_sha: FullShaSchema }).optional(),
});

function repositoryParts(slug: string): { owner: string; repository: string } {
  const [owner, repositoryName] = slug.split('/');
  if (!owner || !repositoryName) throw new Error('Invalid GitHub repository slug');
  return { owner, repository: repositoryName };
}

function parseValidatedGitHubEvent(eventName: string, expectedRepository: string, value: unknown): GitHubReviewContext {
  if (!/^[A-Za-z0-9_]{1,100}$/.test(eventName)) throw new Error('Invalid GITHUB_EVENT_NAME');
  const payload = eventPayload.parse(value);
  const repositorySlug = RepositorySlugSchema.parse(expectedRepository);
  if (payload.repository.full_name.toLowerCase() !== repositorySlug.toLowerCase()) {
    throw new Error('Event repository does not match GITHUB_REPOSITORY');
  }
  const { owner, repository: repositoryName } = repositoryParts(repositorySlug);
  if (payload.repository.owner.login.toLowerCase() !== owner.toLowerCase() || payload.repository.name.toLowerCase() !== repositoryName.toLowerCase()) {
    throw new Error('Event repository fields are inconsistent');
  }
  const common = { eventName, owner, repository: repositoryName, repositorySlug, fork: false };
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    if (!payload.pull_request) throw new Error(`${eventName} payload is missing pull_request metadata`);
    const number = payload.number ?? payload.pull_request.number;
    if (!number) throw new Error('Pull-request payload is missing its number');
    if (payload.number && payload.pull_request.number && payload.number !== payload.pull_request.number) throw new Error('Pull-request numbers are inconsistent');
    if (payload.pull_request.base.repo.full_name.toLowerCase() !== repositorySlug.toLowerCase()) {
      throw new Error('Pull-request base repository does not match the workflow repository');
    }
    const fork = payload.pull_request.head.repo.full_name.toLowerCase() !== repositorySlug.toLowerCase();
    return GitHubReviewContextSchema.parse({
      ...common, kind: eventName === 'pull_request' ? 'pull-request' : 'pull-request-target',
      headRepositorySlug: payload.pull_request.head.repo.full_name,
      pullRequestNumber: number, baseSha: payload.pull_request.base.sha, headSha: payload.pull_request.head.sha, fork,
      safeToAnalyze: eventName === 'pull_request',
      ...(eventName === 'pull_request_target' ? { reason: 'pull_request_target is not allowed to inspect or execute pull-request code with elevated credentials.' } : {}),
    });
  }
  if (eventName === 'merge_group') {
    if (!payload.merge_group) throw new Error('merge_group payload is missing merge_group metadata');
    return GitHubReviewContextSchema.parse({ ...common, kind: 'merge-group', baseSha: payload.merge_group.base_sha,
      headSha: payload.merge_group.head_sha, safeToAnalyze: false, reason: 'Merge queue context is identified but review execution is not yet supported.' });
  }
  if (eventName === 'workflow_dispatch') {
    return GitHubReviewContextSchema.parse({ ...common, kind: 'manual', safeToAnalyze: false,
      reason: 'Manual events do not provide a trusted pull-request base and head.' });
  }
  return GitHubReviewContextSchema.parse({ ...common, kind: 'unsupported', safeToAnalyze: false,
    reason: `Unsupported GitHub event: ${eventName}` });
}

export function parseGitHubEvent(eventName: string, expectedRepository: string, value: unknown): GitHubReviewContext {
  try { return parseValidatedGitHubEvent(eventName, expectedRepository, value); }
  catch (error) {
    if (error instanceof z.ZodError) throw new Error('GitHub event payload failed schema validation');
    throw error;
  }
}

export async function readGitHubEvent(path: string, eventName: string, expectedRepository: string, maxBytes = 1_048_576): Promise<GitHubReviewContext> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`GitHub event payload must be a regular file no larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1); let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break; total += bytesRead;
    }
    if (total > maxBytes) throw new Error(`GitHub event payload exceeds ${maxBytes} bytes`);
    bytes = buffer.subarray(0, total);
  } finally { await handle.close(); }
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new Error('GitHub event payload is not valid JSON'); }
  return parseGitHubEvent(eventName, expectedRepository, value);
}
