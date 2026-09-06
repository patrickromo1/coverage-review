import { z } from 'zod';

export const FullShaSchema = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).transform((value) => value.toLowerCase());
export const OwnerSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
export const RepositoryNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).refine((value) => value !== '.' && value !== '..');
export const RepositorySlugSchema = z.string().refine((value) => {
  const [owner, repository, extra] = value.split('/');
  return extra === undefined && OwnerSchema.safeParse(owner).success && RepositoryNameSchema.safeParse(repository).success;
}, 'Expected owner/repository');

export const GitHubReviewContextSchema = z.strictObject({
  kind: z.enum(['pull-request', 'pull-request-target', 'merge-group', 'manual', 'unsupported']),
  eventName: z.string().min(1).max(100),
  owner: OwnerSchema,
  repository: RepositoryNameSchema,
  repositorySlug: RepositorySlugSchema,
  headRepositorySlug: RepositorySlugSchema.optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  baseSha: FullShaSchema.optional(),
  headSha: FullShaSchema.optional(),
  fork: z.boolean(),
  safeToAnalyze: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
});
export type GitHubReviewContext = z.infer<typeof GitHubReviewContextSchema>;

export const PullRequestMetadataSchema = z.strictObject({
  number: z.number().int().positive(),
  baseSha: FullShaSchema,
  headSha: FullShaSchema,
  baseRepository: RepositorySlugSchema,
  headRepository: RepositorySlugSchema,
});
export type PullRequestMetadata = z.infer<typeof PullRequestMetadataSchema>;

export const ComparisonSchema = z.strictObject({
  baseSha: FullShaSchema,
  headSha: FullShaSchema,
  mergeBaseSha: FullShaSchema,
});
export type GitHubComparison = z.infer<typeof ComparisonSchema>;

export const CheckAnnotationSchema = z.strictObject({
  path: z.string().min(1).max(500),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  annotation_level: z.enum(['notice', 'warning', 'failure']),
  title: z.string().min(1).max(255),
  message: z.string().min(1).max(65_535),
});
export type CheckAnnotation = z.infer<typeof CheckAnnotationSchema>;

export interface CheckRunOutput {
  readonly title: string;
  readonly summary: string;
  readonly annotations?: readonly CheckAnnotation[];
}

export interface GitHubClient {
  getPullRequest(owner: string, repository: string, number: number, signal: AbortSignal): Promise<PullRequestMetadata>;
  compareCommits(owner: string, repository: string, baseSha: string, headSha: string, signal: AbortSignal): Promise<GitHubComparison>;
  createCheckRun(owner: string, repository: string, request: {
    readonly name: string; readonly headSha: string; readonly conclusion: CheckConclusion; readonly output: CheckRunOutput;
  }, signal: AbortSignal): Promise<{ readonly id: number }>;
  updateCheckRun(owner: string, repository: string, id: number, request: {
    readonly name: string; readonly conclusion: CheckConclusion; readonly output: CheckRunOutput;
  }, signal: AbortSignal): Promise<void>;
}

export type CheckConclusion = 'success' | 'failure' | 'neutral';
export type PublishingStatus =
  | { readonly status: 'not-requested' }
  | { readonly status: 'published'; readonly checkRunId: number; readonly annotationsPublished: number; readonly annotationsTruncated: number }
  | { readonly status: 'failed'; readonly reason: 'missing-token' | 'permission-denied' | 'cancelled' | 'api-error' | 'invalid-response' };
