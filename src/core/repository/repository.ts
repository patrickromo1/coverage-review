export type SourceRead =
  | { readonly status: 'available'; readonly content: string }
  | { readonly status: 'missing' | 'binary' | 'truncated' | 'unsupported'; readonly reason: string };

export interface RepositoryFileListing {
  readonly status: 'available' | 'truncated';
  readonly paths: readonly string[];
  readonly reason?: string;
}

/** Commit-addressed repository reads. Implementations must never consult the working tree. */
export interface Repository {
  page?(query: { snapshot: string; prefix?: string; size?: number; cursor?: string }, signal?: AbortSignal): Promise<{ status: 'available' | 'truncated'; paths: readonly string[]; total: number; nextCursor: string | null }>;
  readSource(commitSha: string, path: string, signal?: AbortSignal, maxBytes?: number): Promise<SourceRead>;
  listFiles(commitSha: string, signal?: AbortSignal): Promise<RepositoryFileListing>;
}

export function assertRepositoryPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
      /^[A-Za-z]:/.test(path) || path.split('/').some((part) => part === '..' || part === '.' || !part)) {
    throw new Error(`Invalid repository-relative path: ${JSON.stringify(path)}`);
  }
}

/** Bounded deterministic traversal; a final page never erases upstream truncation. */
export async function discoveryListing(repository: Repository, snapshot: string, signal?: AbortSignal): Promise<RepositoryFileListing> {
  if (!repository.page) return repository.listFiles(snapshot, signal);
  const paths: string[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < 40; page++) {
    signal?.throwIfAborted();
    const result = await repository.page({ snapshot, size: 500, ...(cursor ? { cursor } : {}) }, signal);
    if (result.paths.length > 500) throw new Error('Oversized repository page');
    paths.push(...result.paths);
    truncated ||= result.status === 'truncated';
    if (!result.nextCursor) return { status: truncated ? 'truncated' : 'available', paths, ...(truncated ? { reason: 'Discovery listing is incomplete' } : {}) };
    if (cursor === result.nextCursor) throw new Error('Non-advancing repository cursor');
    cursor = result.nextCursor;
  }
  return { status: 'truncated', paths, reason: 'Discovery page budget exhausted' };
}
