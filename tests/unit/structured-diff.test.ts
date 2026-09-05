import { expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../src/core/diff/structured-diff.js';

it('parses hunks and changed ranges without treating headers as source lines', () => {
  const result = parseUnifiedDiff(
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@ function x\n same\n-old\n+new\n+extra\n end\n',
    { path: 'a.ts', status: 'modified' },
  );
  expect(result.binary).toBe(false);
  expect(result.baseChangedLines).toEqual([{ start: 2, end: 2 }]);
  expect(result.headChangedLines).toEqual([{ start: 2, end: 3 }]);
  expect(result.hunks[0]?.lines.map((line) => line.kind)).toEqual(['context', 'deletion', 'addition', 'addition', 'context']);
});

it('handles deletions, header-looking content, renames without hunks, and binary changes', () => {
  const deleted = parseUnifiedDiff('@@ -1,2 +0,0 @@\n---- value\n-+++ value\n', { path: 'gone.ts', status: 'deleted' });
  expect(deleted.baseChangedLines).toEqual([{ start: 1, end: 2 }]);
  expect(deleted.headChangedLines).toEqual([]);
  expect(parseUnifiedDiff('similarity index 100%\nrename from a.ts\nrename to b.ts\n', { path: 'b.ts', previousPath: 'a.ts', status: 'renamed' }).hunks).toEqual([]);
  expect(parseUnifiedDiff('Binary files a/x.png and b/x.png differ\n', { path: 'x.png', status: 'modified' }).binary).toBe(true);
});

it('rejects malformed hunk counts', () => {
  expect(() => parseUnifiedDiff('@@ -1 +1 @@\n-old\n', { path: 'a.ts', status: 'modified' })).toThrow('counts');
});
