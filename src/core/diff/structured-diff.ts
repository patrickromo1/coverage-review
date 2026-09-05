import type { ChangedFile } from './diff-provider.js';

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface DiffLine {
  readonly kind: 'context' | 'addition' | 'deletion';
  readonly content: string;
  readonly baseLine?: number;
  readonly headLine?: number;
}

export interface DiffHunk {
  readonly base: { readonly start: number; readonly count: number };
  readonly head: { readonly start: number; readonly count: number };
  readonly section?: string;
  readonly lines: readonly DiffLine[];
}

export interface StructuredFileDiff extends ChangedFile {
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
  readonly baseChangedLines: readonly LineRange[];
  readonly headChangedLines: readonly LineRange[];
}

function ranges(lines: readonly number[]): LineRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const result: LineRange[] = [];
  for (const line of sorted) {
    const last = result.at(-1);
    if (last && line === last.end + 1) result[result.length - 1] = { start: last.start, end: line };
    else result.push({ start: line, end: line });
  }
  return result;
}

/** Parse the patch for one already-identified changed file. */
export function parseUnifiedDiff(patch: string, file: ChangedFile): StructuredFileDiff {
  const binary = /^(?:Binary files .* differ|GIT binary patch)$/m.test(patch);
  const hunks: DiffHunk[] = [];
  const baseChanged: number[] = [];
  const headChanged: number[] = [];
  const input = patch.split('\n');
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/;

  for (let index = 0; index < input.length; index += 1) {
    const match = header.exec(input[index] ?? '');
    if (!match) continue;
    const baseStart = Number(match[1]);
    const baseCount = match[2] === undefined ? 1 : Number(match[2]);
    const headStart = Number(match[3]);
    const headCount = match[4] === undefined ? 1 : Number(match[4]);
    let baseLine = baseStart;
    let headLine = headStart;
    const lines: DiffLine[] = [];
    index += 1;
    while (index < input.length && !header.test(input[index] ?? '')) {
      const raw = input[index] ?? '';
      if (raw.startsWith('diff --git ')) { index -= 1; break; }
      if (raw.startsWith('\\ No newline at end of file')) { index += 1; continue; }
      if (raw.startsWith('+')) {
        lines.push({ kind: 'addition', content: raw.slice(1), headLine });
        headChanged.push(headLine);
        headLine += 1;
      } else if (raw.startsWith('-')) {
        lines.push({ kind: 'deletion', content: raw.slice(1), baseLine });
        baseChanged.push(baseLine);
        baseLine += 1;
      } else if (raw.startsWith(' ')) {
        lines.push({ kind: 'context', content: raw.slice(1), baseLine, headLine });
        baseLine += 1;
        headLine += 1;
      } else if (raw === '') {
        // A trailing split artifact is not a diff line.
      } else {
        throw new Error(`Malformed unified diff line in hunk: ${raw}`);
      }
      index += 1;
    }
    if (baseLine - baseStart !== baseCount || headLine - headStart !== headCount) {
      throw new Error('Unified diff hunk line counts do not match its header');
    }
    const hunk: DiffHunk = {
      base: { start: baseStart, count: baseCount }, head: { start: headStart, count: headCount }, lines,
      ...(match[5] ? { section: match[5] } : {}),
    };
    hunks.push(hunk);
    index -= 1;
  }
  return { ...file, binary, hunks, baseChangedLines: ranges(baseChanged), headChangedLines: ranges(headChanged) };
}
