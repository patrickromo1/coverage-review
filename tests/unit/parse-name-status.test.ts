import { describe, expect, it } from 'vitest';
import { parseNameStatus } from '../../src/core/diff/parse-name-status.js';

describe('parseNameStatus', () => {
  it('preserves whitespace and parses all supported statuses', () => {
    expect(parseNameStatus('A\0new file\0M\0tab\tfile\0D\0old\0T\0link\0R100\0before\0after\nname\0')).toEqual([
      { status: 'added', path: 'new file' }, { status: 'modified', path: 'tab\tfile' },
      { status: 'deleted', path: 'old' }, { status: 'type-changed', path: 'link' },
      { status: 'renamed', path: 'after\nname', previousPath: 'before' },
    ]);
  });
  it('accepts an empty diff', () => expect(parseNameStatus('')).toEqual([]));
  it.each(['M\0file', 'R100\0old\0', 'X\0file\0', 'A\0\0', 'R101\0old\0new\0'])(
    'rejects malformed or unsupported output %j', (output) => expect(() => parseNameStatus(output)).toThrow(),
  );
});
