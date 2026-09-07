import { parseBoundedJson } from './bounded-json.js';
import { z } from 'zod';
import type { FileCoverage } from './coverage-provider.js';
import { assertRepositoryPath } from '../repository/repository.js';
const lines = z.array(z.number().int().positive().safe()).max(200_000);
const arcs = z.array(z.tuple([z.number().int().positive().safe(), z.number().int().safe()])).max(200_000);
const fileSchema = z.object({ executed_lines: lines, missing_lines: lines, excluded_lines: lines,
  executed_branches: arcs.optional(), missing_branches: arcs.optional() });
const schema = z.object({ meta: z.object({ format: z.literal(3), branch_coverage: z.boolean() }), files: z.record(z.string(), fileSchema) });

/** Coverage.py format 3 booleans use 0/1 hits, not execution frequencies. */
export function parseCoveragePy(content: string): { files: FileCoverage[]; diagnostics: string[] } {
  const report = schema.parse(parseBoundedJson(content));
  if (Object.keys(report.files).length > 20_000) throw new Error('Coverage file budget exhausted');
  const files: FileCoverage[] = [];
  for (const [path, value] of Object.entries(report.files)) {
    assertRepositoryPath(path);
    const measured = new Set<number>();
    const fileLines = [ ...value.executed_lines.map((line) => ({ line, hits: 1, covered: true })), ...value.missing_lines.map((line) => ({ line, hits: 0, covered: false })) ];
    for (const line of [...fileLines.map((entry) => entry.line), ...value.excluded_lines]) {
      if (measured.has(line)) throw new Error('Duplicate or conflicting JSON line');
      measured.add(line);
    }
    if (report.meta.branch_coverage && (!value.executed_branches || !value.missing_branches)) throw new Error('Missing branch measurements');
    if (!report.meta.branch_coverage && (value.executed_branches || value.missing_branches)) throw new Error('Conflicting branch metadata');
    const seen = new Set<string>();
    const branches = [...(value.executed_branches ?? []).map(([line, target]) => ({ line, block: 'arc', branch: String(target), hits: 1, covered: true })),
      ...(value.missing_branches ?? []).map(([line, target]) => ({ line, block: 'arc', branch: String(target), hits: 0, covered: false }))];
    for (const branch of branches) { const key = `${branch.line}:${branch.branch}`; if (seen.has(key)) throw new Error('Duplicate or conflicting JSON branch'); seen.add(key); }
    files.push({ path, lines: fileLines.sort((a, b) => a.line - b.line), branches: branches.sort((a, b) => a.line - b.line || a.branch.localeCompare(b.branch)) });
  }
  return { files: files.sort((a, b) => a.path < b.path ? -1 : 1), diagnostics: report.meta.branch_coverage ? [] : ['Coverage.py branch measurement was disabled'] };
}
