export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'type-changed';

export interface ChangedFile {
  /** Head path, or base path for a deletion. */
  readonly path: string;
  readonly status: ChangeStatus;
  readonly previousPath?: string;
}

export interface GitComparison {
  readonly baseSha: string;
  readonly headSha: string;
  readonly files: readonly ChangedFile[];
}

/** Substitute an in-memory implementation for eval fixtures. */
export interface DiffProvider {
  stats?(): { requests: number; bytes: number; comparisons: number; cacheHits: number };
  compare(baseSha: string, headSha: string, signal?: AbortSignal): Promise<GitComparison>;
  /** Path must identify a changed file in this exact comparison. */
  getFileDiff(baseSha: string, headSha: string, path: string, signal?: AbortSignal): Promise<string>;
}
