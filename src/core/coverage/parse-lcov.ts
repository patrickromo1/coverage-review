import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { assertRepositoryPath } from '../repository/repository.js';
import type { BranchCoverage, FileCoverage, LineCoverage } from './coverage-provider.js';

function normalizeReportPath(value: string, repositoryRoot: string): string {
  if (!value || value.includes('\0')) throw new Error('LCOV SF record has an invalid path');
  let path: string;
  if (isAbsolute(value)) {
    const relativePath = relative(resolve(repositoryRoot), resolve(value));
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`LCOV source path escapes repository: ${value}`);
    }
    path = relativePath.split(sep).join('/');
  } else {
    path = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '');
  }
  assertRepositoryPath(path);
  return path;
}

function natural(value: string, label: string, positive = false): number {
  if (!/^\d+$/.test(value)) throw new Error(`Malformed LCOV ${label}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (positive ? parsed < 1 : parsed < 0)) throw new Error(`Malformed LCOV ${label}: ${value}`);
  return parsed;
}

/** Strictly parses deterministic line and branch records; unsupported LCOV summary records are ignored. */
export function parseLcov(content: string, repositoryRoot: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let path: string | undefined;
  let lines: LineCoverage[] = [];
  let branches: BranchCoverage[] = [];
  const seen = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    if (!raw) continue;
    if (raw.startsWith('SF:')) {
      if (path !== undefined) throw new Error('LCOV record started before previous end_of_record');
      path = normalizeReportPath(raw.slice(3), repositoryRoot);
      lines = [];
      branches = [];
    } else if (raw.startsWith('DA:')) {
      if (!path) throw new Error('LCOV DA record appears before SF');
      const fields = raw.slice(3).split(',');
      if (fields.length < 2 || !fields[0] || !fields[1]) throw new Error(`Malformed LCOV DA record: ${raw}`);
      const line = natural(fields[0], 'line number', true);
      const hits = natural(fields[1], 'line hits');
      lines.push({ line, hits, covered: hits > 0 });
    } else if (raw.startsWith('BRDA:')) {
      if (!path) throw new Error('LCOV BRDA record appears before SF');
      const fields = raw.slice(5).split(',');
      if (fields.length !== 4 || fields.some((field) => field === '')) throw new Error(`Malformed LCOV BRDA record: ${raw}`);
      const [lineValue, block, branch, taken] = fields as [string, string, string, string];
      const line = natural(lineValue, 'branch line', true);
      const hits = taken === '-' ? null : natural(taken, 'branch hits');
      branches.push({ line, block, branch, hits, covered: hits !== null && hits > 0 });
    } else if (raw === 'end_of_record') {
      if (!path) throw new Error('LCOV end_of_record appears before SF');
      if (seen.has(path)) throw new Error(`Duplicate LCOV source record after normalization: ${path}`);
      seen.add(path);
      files.push({
        path, lines: lines.sort((a, b) => a.line - b.line),
        branches: branches.sort((a, b) => a.line - b.line || a.block.localeCompare(b.block) || a.branch.localeCompare(b.branch)),
      });
      path = undefined;
    } else if (!/^(?:TN|FN|FNDA|FNF|FNH|LF|LH|BRF|BRH):/.test(raw)) {
      throw new Error(`Unsupported LCOV record: ${raw}`);
    }
  }
  if (path !== undefined) throw new Error('LCOV record is missing end_of_record');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
