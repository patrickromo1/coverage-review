import { z } from 'zod';
import {
  CheckAnnotationSchema, ComparisonSchema, FullShaSchema, PullRequestMetadataSchema,
  OwnerSchema, RepositoryNameSchema, type CheckConclusion, type CheckRunOutput, type GitHubClient,
} from './domain.js';

const prResponse = z.object({
  number: z.number().int().positive(),
  base: z.object({ sha: FullShaSchema, repo: z.object({ full_name: z.string() }) }),
  head: z.object({ sha: FullShaSchema, repo: z.object({ full_name: z.string() }) }),
});
const compareResponse = z.object({
  base_commit: z.object({ sha: FullShaSchema }),
  merge_base_commit: z.object({ sha: FullShaSchema }),
  commits: z.array(z.unknown()).max(250).optional(),
  files: z.array(z.unknown()).max(300).optional(),
});
const checkResponse = z.object({ id: z.number().int().positive() });

export class GitHubApiError extends Error {
  constructor(readonly category: 'permission-denied' | 'cancelled' | 'api-error' | 'invalid-response') {
    super(`GitHub API request failed (${category})`);
  }
}

export interface GitHubRestClientOptions {
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxRequests?: number;
  readonly maxResponseBytes?: number;
  readonly maxRetries?: number;
}

export class GitHubRestClient implements GitHubClient {
  private requests = 0;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxRequests: number;
  private readonly maxResponseBytes: number;
  private readonly maxRetries: number;

  constructor(private readonly options: GitHubRestClientOptions) {
    if (!options.token) throw new Error('GitHub token is required');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxRequests = options.maxRequests ?? 30;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.maxRetries = options.maxRetries ?? 2;
    for (const value of [this.maxRequests, this.maxResponseBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid GitHub client bound');
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 5) throw new Error('Invalid GitHub retry bound');
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    if (!path.startsWith('/repos/')) throw new Error('GitHub client path must be repository-scoped');
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      if (++this.requests > this.maxRequests) throw new GitHubApiError('api-error');
      let response: Response;
      try {
        response = await this.fetchImpl(`https://api.github.com${path}`, {
          ...init, signal, headers: {
            Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.options.token}`,
            'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'coverage-review/0.1',
            ...init.headers,
          },
        });
      } catch {
        if (signal.aborted) throw new GitHubApiError('cancelled');
        throw new GitHubApiError('api-error');
      }
      if (response.ok) return this.readJson(response);
      if (response.status === 401 || response.status === 403) throw new GitHubApiError('permission-denied');
      const retryable = [429, 502, 503, 504].includes(response.status);
      if (!retryable || attempt >= this.maxRetries) throw new GitHubApiError('api-error');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(500, 100 * 2 ** attempt));
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new GitHubApiError('cancelled')); }, { once: true });
      });
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > this.maxResponseBytes) throw new GitHubApiError('invalid-response');
    const reader = response.body?.getReader();
    if (!reader) throw new GitHubApiError('invalid-response');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > this.maxResponseBytes) { await reader.cancel(); throw new GitHubApiError('invalid-response'); }
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new GitHubApiError('invalid-response'); }
  }

  async getPullRequest(owner: string, repository: string, number: number, signal: AbortSignal) {
    owner = OwnerSchema.parse(owner); repository = RepositoryNameSchema.parse(repository);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull-request number');
    const value = prResponse.safeParse(await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}`, { method: 'GET' }, signal));
    if (!value.success) throw new GitHubApiError('invalid-response');
    return PullRequestMetadataSchema.parse({ number: value.data.number, baseSha: value.data.base.sha, headSha: value.data.head.sha,
      baseRepository: value.data.base.repo.full_name, headRepository: value.data.head.repo.full_name });
  }

  async compareCommits(owner: string, repository: string, baseSha: string, headSha: string, signal: AbortSignal) {
    owner = OwnerSchema.parse(owner); repository = RepositoryNameSchema.parse(repository);
    const base = FullShaSchema.parse(baseSha); const head = FullShaSchema.parse(headSha);
    const value = compareResponse.safeParse(await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${base}...${head}?per_page=1&page=1`, { method: 'GET' }, signal,
    ));
    if (!value.success) throw new GitHubApiError('invalid-response');
    return ComparisonSchema.parse({ baseSha: value.data.base_commit.sha, headSha: head, mergeBaseSha: value.data.merge_base_commit.sha });
  }

  async createCheckRun(owner: string, repository: string, request: { readonly name: string; readonly headSha: string; readonly conclusion: CheckConclusion; readonly output: CheckRunOutput }, signal: AbortSignal) {
    owner = OwnerSchema.parse(owner); repository = RepositoryNameSchema.parse(repository);
    const value = checkResponse.safeParse(await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/check-runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checkBody(request)),
    }, signal));
    if (!value.success) throw new GitHubApiError('invalid-response');
    return { id: value.data.id };
  }

  async updateCheckRun(owner: string, repository: string, id: number, request: { readonly name: string; readonly conclusion: CheckConclusion; readonly output: CheckRunOutput }, signal: AbortSignal) {
    owner = OwnerSchema.parse(owner); repository = RepositoryNameSchema.parse(repository);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid Check Run id');
    await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/check-runs/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checkBody(request)),
    }, signal);
  }
}

function checkBody(request: { readonly name: string; readonly headSha?: string; readonly conclusion: CheckConclusion; readonly output: CheckRunOutput }) {
  const output = { title: request.output.title, summary: request.output.summary,
    ...(request.output.annotations ? { annotations: request.output.annotations.map((annotation) => CheckAnnotationSchema.parse(annotation)) } : {}) };
  return { name: request.name, ...(request.headSha ? { head_sha: FullShaSchema.parse(request.headSha) } : {}),
    status: 'completed', conclusion: request.conclusion, completed_at: new Date().toISOString(), output };
}
