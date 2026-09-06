import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertRepositoryPath, type Repository, type RepositoryFileListing, type SourceRead } from '../../core/repository/repository.js';

const execute = promisify(execFile);

/** Reads blobs from Git objects, so uncommitted working-tree changes cannot affect evidence. */
export class LocalRepository implements Repository {
  constructor(
    private readonly root: string,
    private readonly maxBytes = 1_048_576,
    private readonly maxFiles = 20_000,
    private readonly maxTreeBytes = 16 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
    if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new Error('maxFiles must be a positive integer');
    if (!Number.isSafeInteger(maxTreeBytes) || maxTreeBytes <= 0) throw new Error('maxTreeBytes must be a positive integer');
  }

  private async git(args: string[], maxBuffer = this.maxBytes + 1, signal?: AbortSignal): Promise<Buffer> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const { stdout } = await execute('git', ['--no-replace-objects', '--literal-pathspecs', ...args], {
      cwd: this.root, encoding: 'buffer', maxBuffer, timeout: 30_000, ...(signal ? { signal } : {}),
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    });
    return stdout;
  }

  private assertCommit(commitSha: string): void {
    if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commitSha)) {
      throw new Error('Expected a full 40- or 64-character Git commit SHA');
    }
  }

  async readSource(commitSha: string, path: string, signal?: AbortSignal, maxBytes = this.maxBytes): Promise<SourceRead> {
    this.assertCommit(commitSha);
    assertRepositoryPath(path);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid read byte limit');
    const readLimit = Math.min(this.maxBytes, maxBytes);
    signal?.throwIfAborted();
    try {
      const entry = (await this.git(['ls-tree', '-z', commitSha, '--', path], 4096, signal)).toString('utf8');
      if (!entry) return { status: 'missing', reason: 'Path does not exist at commit' };
      const match = /^(\d{6}) ([^ ]+) [a-fA-F0-9]+\t([^\0]+)\0$/.exec(entry);
      if (!match || match[3] !== path) return { status: 'unsupported', reason: 'Git returned an unexpected tree entry' };
      if (match[1] === '120000') return { status: 'unsupported', reason: 'Symbolic-link sources are not followed' };
      if (match[2] !== 'blob') return { status: 'unsupported', reason: `Git object is ${match[2]}, not a blob` };
      const size = Number((await this.git(['cat-file', '-s', `${commitSha}:${path}`], 1024, signal)).toString('utf8').trim());
      if (!Number.isSafeInteger(size)) return { status: 'unsupported', reason: 'Git returned an invalid blob size' };
      if (size > readLimit) return { status: 'truncated', reason: `Source exceeds ${readLimit} byte read limit` };
      const content = await this.git(['show', `${commitSha}:${path}`], readLimit + 1, signal);
      if (content.includes(0)) return { status: 'binary', reason: 'Source blob contains NUL bytes' };
      return { status: 'available', content: content.toString('utf8') };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/does not exist|exists on disk, but not in|Not a valid object name|invalid object name/i.test(message)) {
        return { status: 'missing', reason: 'Path does not exist at commit' };
      }
      throw error;
    }
  }

  async listFiles(commitSha: string, signal?: AbortSignal): Promise<RepositoryFileListing> {
    this.assertCommit(commitSha);
    let output: Buffer;
    try {
      output = await this.git(['ls-tree', '-r', '-z', '--name-only', commitSha], this.maxTreeBytes, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/maxBuffer|too large|truncat/i.test(message)) {
        return { status: 'truncated', paths: [], reason: `Git tree listing exceeds ${this.maxTreeBytes} byte limit` };
      }
      throw error;
    }
    const fields = output.toString('utf8').split('\0');
    if (fields.at(-1) !== '') throw new Error('Truncated Git tree output');
    fields.pop();
    const paths = fields.slice(0, this.maxFiles);
    for (const path of paths) assertRepositoryPath(path);
    return fields.length > this.maxFiles
      ? { status: 'truncated', paths, reason: `Repository contains more than ${this.maxFiles} files` }
      : { status: 'available', paths };
  }
}
