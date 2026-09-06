import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DiffProvider, GitComparison } from '../../core/diff/diff-provider.js';
import { parseNameStatus } from '../../core/diff/parse-name-status.js';
import { assertRepositoryPath } from '../../core/repository/repository.js';

const execute = promisify(execFile);
const diffOptions = [
  '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames=50%',
  '--diff-algorithm=myers', '--no-indent-heuristic', '--ignore-submodules=none',
];

export class LocalGitDiff implements DiffProvider {
  private cached: GitComparison | undefined;
  private readonly metrics = { requests: 0, bytes: 0, comparisons: 0, cacheHits: 0 };
  constructor(private readonly root: string) {}
  stats() { return { ...this.metrics }; }

  private async git(args: string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.metrics.requests++;
    // Inherited Git overrides must not redirect reads or inject configuration.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const { stdout } = await execute('git', ['--no-replace-objects', '--literal-pathspecs', '-c', 'diff.renameLimit=1000', ...args], {
      cwd: this.root, ...(signal ? { signal } : {}),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    });
    this.metrics.bytes += Buffer.byteLength(stdout);
    return stdout;
  }

  private async resolveCommit(sha: string, signal?: AbortSignal): Promise<string> {
    if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(sha)) {
      throw new Error('Expected a full 40- or 64-character Git commit SHA');
    }
    return (await this.git(['rev-parse', '--verify', `${sha}^{commit}`], signal)).trim();
  }

  async compare(baseSha: string, headSha: string, signal?: AbortSignal): Promise<GitComparison> {
    signal?.throwIfAborted();
    if (this.cached?.baseSha === baseSha.toLowerCase() && this.cached.headSha === headSha.toLowerCase()) {
      this.metrics.cacheHits++;
      return structuredClone(this.cached);
    }
    this.metrics.comparisons++;
    const base = await this.resolveCommit(baseSha, signal);
    const head = await this.resolveCommit(headSha, signal);
    const output = await this.git(['diff', ...diffOptions, '--name-status', '-z', base, head, '--'], signal);
    this.cached = { baseSha: base, headSha: head, files: parseNameStatus(output).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    if (this.cached.files.length > 20_000) { this.cached = undefined; throw new Error('Changed-file enumeration exceeds 20000 files'); }
    return structuredClone(this.cached);
  }

  async getFileDiff(baseSha: string, headSha: string, path: string, signal?: AbortSignal): Promise<string> {
    assertRepositoryPath(path);
    const comparison = await this.compare(baseSha, headSha, signal);
    const file = comparison.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`File is not changed in this comparison: ${path}`);
    const paths = file.previousPath ? [file.previousPath, file.path] : [file.path];
    return this.git([
      'diff', ...diffOptions, '--patch', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/',
      '--submodule=short', comparison.baseSha, comparison.headSha, '--', ...paths,
    ], signal);
  }
}
