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
  constructor(private readonly root: string) {}

  private async git(args: string[]): Promise<string> {
    // Inherited Git overrides must not redirect reads or inject configuration.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const { stdout } = await execute('git', ['--no-replace-objects', '--literal-pathspecs', '-c', 'diff.renameLimit=1000', ...args], {
      cwd: this.root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    });
    return stdout;
  }

  private async resolveCommit(sha: string): Promise<string> {
    if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(sha)) {
      throw new Error('Expected a full 40- or 64-character Git commit SHA');
    }
    return (await this.git(['rev-parse', '--verify', `${sha}^{commit}`])).trim();
  }

  async compare(baseSha: string, headSha: string): Promise<GitComparison> {
    const base = await this.resolveCommit(baseSha);
    const head = await this.resolveCommit(headSha);
    const output = await this.git(['diff', ...diffOptions, '--name-status', '-z', base, head, '--']);
    return { baseSha: base, headSha: head, files: parseNameStatus(output) };
  }

  async getFileDiff(baseSha: string, headSha: string, path: string): Promise<string> {
    assertRepositoryPath(path);
    const comparison = await this.compare(baseSha, headSha);
    const file = comparison.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`File is not changed in this comparison: ${path}`);
    const paths = file.previousPath ? [file.previousPath, file.path] : [file.path];
    return this.git([
      'diff', ...diffOptions, '--patch', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/',
      '--submodule=short', comparison.baseSha, comparison.headSha, '--', ...paths,
    ]);
  }
}
