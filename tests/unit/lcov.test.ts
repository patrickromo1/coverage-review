import { expect, it } from 'vitest';
import { parseLcov } from '../../src/core/coverage/parse-lcov.js';

it('normalizes paths and preserves zero and unknown branch measurements', () => {
  const files = parseLcov('SF:./src/a.ts\nDA:2,0\nDA:3,4\nBRDA:3,0,0,-\nBRDA:3,0,1,0\nend_of_record\n', '/repo');
  expect(files).toEqual([{ path: 'src/a.ts', lines: [
    { line: 2, hits: 0, covered: false }, { line: 3, hits: 4, covered: true },
  ], branches: [
    { line: 3, block: '0', branch: '0', hits: null, covered: null },
    { line: 3, block: '0', branch: '1', hits: 0, covered: false },
  ] }]);
});

it('normalizes absolute in-repository paths and rejects escaping and malformed reports', () => {
  expect(parseLcov('SF:/repo/src/a.ts\nDA:1,1\nend_of_record\n', '/repo')[0]?.path).toBe('src/a.ts');
  expect(() => parseLcov('SF:/outside/a.ts\nend_of_record\n', '/repo')).toThrow('escapes');
  expect(() => parseLcov('SF:src/a.ts\nDA:nope,1\nend_of_record\n', '/repo')).toThrow('Malformed');
  expect(() => parseLcov('SF:src/a.ts\nDA:1,1\n', '/repo')).toThrow('end_of_record');
});
