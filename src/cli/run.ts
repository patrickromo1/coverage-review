import { parseArgs } from 'node:util';
import type { DiffProvider } from '../core/diff/diff-provider.js';

export const usage = `Usage: coverage-review --base <SHA> --head <SHA> [--repo <path>] [--file <path>]

Print changed files as JSON, or a single file's patch with --file.
Requires full commit SHAs. Compares the two commits directly (no merge-base).
This milestone inspects Git changes only; it does not generate coverage reviews.
`;

export async function runCli(
  args: string[],
  createDiff: (root: string) => DiffProvider,
): Promise<string> {
  const { values } = parseArgs({
    args,
    options: {
      base: { type: 'string' }, head: { type: 'string' },
      repo: { type: 'string', default: '.' }, file: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return usage;
  if (!values.base || !values.head) throw new Error('Both --base and --head are required. Use --help for usage.');
  const diff = createDiff(values.repo);
  if (values.file !== undefined) return diff.getFileDiff(values.base, values.head, values.file);
  return `${JSON.stringify(await diff.compare(values.base, values.head), null, 2)}\n`;
}
