import { expect, it, vi } from 'vitest';
import { GitHubApiError, GitHubRestClient } from '../../src/github/rest-client.js';

const base = 'a'.repeat(40); const head = 'b'.repeat(40); const merge = 'c'.repeat(40);
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }

it('validates bounded metadata and comparison responses', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({ number: 4, base: { sha: base, repo: { full_name: 'octo/repo' } }, head: { sha: head, repo: { full_name: 'fork/repo' } } }))
    .mockResolvedValueOnce(json({ base_commit: { sha: base }, merge_base_commit: { sha: merge }, commits: [], files: [] }));
  const client = new GitHubRestClient({ token: 'SECRET', fetch: fetch as unknown as typeof globalThis.fetch });
  const signal = new AbortController().signal;
  expect(await client.getPullRequest('octo', 'repo', 4, signal)).toMatchObject({ baseSha: base, headSha: head, headRepository: 'fork/repo' });
  expect(await client.compareCommits('octo', 'repo', base, head, signal)).toEqual({ baseSha: base, headSha: head, mergeBaseSha: merge });
  expect(fetch.mock.calls[1]?.[0]).toContain('?per_page=1&page=1');
});

it('bounds retries and does not leak API bodies or credentials', async () => {
  const fetch = vi.fn(async () => json({ message: 'Authorization: Bearer SECRET' }, 503));
  const client = new GitHubRestClient({ token: 'SECRET', fetch: fetch as unknown as typeof globalThis.fetch, maxRetries: 1 });
  let error: unknown;
  try { await client.compareCommits('octo', 'repo', base, head, new AbortController().signal); } catch (caught) { error = caught; }
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(error).toBeInstanceOf(GitHubApiError);
  expect(String(error)).not.toContain('SECRET');
});

it('does not retry permission errors and enforces request and response limits', async () => {
  const denied = vi.fn(async () => json({}, 403));
  const client = new GitHubRestClient({ token: 'x', fetch: denied as unknown as typeof globalThis.fetch });
  await expect(client.compareCommits('octo', 'repo', base, head, new AbortController().signal)).rejects.toMatchObject({ category: 'permission-denied' });
  expect(denied).toHaveBeenCalledOnce();
  const oversized = new GitHubRestClient({ token: 'x', maxResponseBytes: 2, fetch: vi.fn(async () => json({ ok: true })) as unknown as typeof globalThis.fetch });
  await expect(oversized.compareCommits('octo', 'repo', base, head, new AbortController().signal)).rejects.toMatchObject({ category: 'invalid-response' });
});

it('prevents requests after cancellation', async () => {
  const fetch = vi.fn(); const controller = new AbortController(); controller.abort();
  const client = new GitHubRestClient({ token: 'x', fetch: fetch as unknown as typeof globalThis.fetch });
  await expect(client.compareCommits('octo', 'repo', base, head, controller.signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('enforces the total request budget', async () => {
  const fetch = vi.fn(async () => json({ base_commit: { sha: base }, merge_base_commit: { sha: merge }, commits: [], files: [] }));
  const client = new GitHubRestClient({ token: 'x', maxRequests: 1, fetch: fetch as unknown as typeof globalThis.fetch });
  await client.compareCommits('octo', 'repo', base, head, new AbortController().signal);
  await expect(client.compareCommits('octo', 'repo', base, head, new AbortController().signal)).rejects.toMatchObject({ category: 'api-error' });
  expect(fetch).toHaveBeenCalledOnce();
});
