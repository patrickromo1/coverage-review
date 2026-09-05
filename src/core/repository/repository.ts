/** Repository-relative paths use forward slashes. Reads are of the working tree. */
export interface Repository {
  readSource(path: string): Promise<string>;
}

export function assertRepositoryPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
      /^[A-Za-z]:/.test(path) || path.split('/').some((part) => part === '..' || part === '.' || !part)) {
    throw new Error(`Invalid repository-relative path: ${JSON.stringify(path)}`);
  }
}
