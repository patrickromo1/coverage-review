import { parseArgs } from 'node:util';
import type { DiffProvider } from '../core/diff/diff-provider.js';
import { collectEvidence, type EvidenceCollectorDependencies } from '../core/evidence/collect-evidence.js';

export const usage = `Usage: coverage-review --base <SHA> --head <SHA> [--repo <path>] [--file <path>]
       coverage-review --base <SHA> --head <SHA> [--repo <path>] --evidence [--lcov <path>] [--coverage-commit <SHA>]

Print changed files as JSON, a single file's patch with --file, or versioned JSON evidence with --evidence.
Requires full commit SHAs. Compares the two commits directly (no merge-base).
Evidence collection reads committed snapshots and never executes repository code or tests.
`;

export async function runCli(
  args: string[],
  createDiff: (root: string) => DiffProvider,
  createEvidence?: (options: { readonly root: string; readonly lcov?: string; readonly coverageCommit?: string }) => EvidenceCollectorDependencies,
): Promise<string> {
  const { values } = parseArgs({
    args,
    options: {
      base: { type: 'string' }, head: { type: 'string' },
      repo: { type: 'string', default: '.' }, file: { type: 'string' },
      evidence: { type: 'boolean' }, lcov: { type: 'string' }, 'coverage-commit': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return usage;
  if (!values.base || !values.head) throw new Error('Both --base and --head are required. Use --help for usage.');
  if (values.file !== undefined && values.evidence) throw new Error('--file and --evidence are mutually exclusive');
  if ((values.lcov !== undefined || values['coverage-commit'] !== undefined) && !values.evidence) {
    throw new Error('--lcov and --coverage-commit require --evidence');
  }
  if (values.evidence) {
    if (!createEvidence) throw new Error('Evidence mode is unavailable');
    const options = {
      root: values.repo,
      ...(values.lcov === undefined ? {} : { lcov: values.lcov }),
      ...(values['coverage-commit'] === undefined ? {} : { coverageCommit: values['coverage-commit'] }),
    };
    return `${JSON.stringify(await collectEvidence(values.base, values.head, createEvidence(options)), null, 2)}\n`;
  }
  const diff = createDiff(values.repo);
  if (values.file !== undefined) return diff.getFileDiff(values.base, values.head, values.file);
  return `${JSON.stringify(await diff.compare(values.base, values.head), null, 2)}\n`;
}
