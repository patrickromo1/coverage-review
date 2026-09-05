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
  readSource(commitSha: string, path: string): Promise<SourceRead>;
  listFiles(commitSha: string): Promise<RepositoryFileListing>;
}

export function assertRepositoryPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
      /^[A-Za-z]:/.test(path) || path.split('/').some((part) => part === '..' || part === '.' || !part)) {
    throw new Error(`Invalid repository-relative path: ${JSON.stringify(path)}`);
  }
}
