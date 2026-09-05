import { expect, it } from 'vitest';
import type { Repository } from '../../src/core/repository/repository.js';
import { TypeScriptTestDiscovery } from '../../src/core/test-discovery/typescript-test-discovery.js';

function repository(files: Record<string, string>): Repository {
  return {
    listFiles: async () => ({ status: 'available', paths: Object.keys(files) }),
    readSource: async (_commit, path) => files[path] === undefined
      ? { status: 'missing', reason: 'missing' }
      : { status: 'available', content: files[path] },
  };
}

it('finds naming, location, and static-import relationships without claiming a test level', async () => {
  const result = await new TypeScriptTestDiscovery().discover({
    repository: repository({
      'src/math.ts': 'export const add = () => 1;',
      'src/math.test.ts': "import { add } from './math.js';",
      'tests/integration/api.spec.ts': "const math = require('../../src/math');",
      'tests/unrelated.test.ts': "import './helper.js';",
    }),
    headSha: 'head', sourcePaths: ['src/math.ts'],
  });
  expect(result.candidates.map((candidate) => [candidate.path, candidate.level])).toEqual([
    ['src/math.test.ts', 'unknown'], ['tests/integration/api.spec.ts', 'integration'],
  ]);
  expect(result.candidates[0]?.relationships).toContainEqual({ type: 'static-import', sourcePath: 'src/math.ts' });
  expect(result.candidates[0]?.uncertainty[0]).toContain('does not prove');
});

it('reports truncated discovery explicitly', async () => {
  const repo: Repository = {
    listFiles: async () => ({ status: 'truncated', paths: ['src/a.test.ts'], reason: 'tree limit' }),
    readSource: async () => ({ status: 'available', content: "import './a.js'" }),
  };
  const result = await new TypeScriptTestDiscovery().discover({ repository: repo, headSha: 'head', sourcePaths: ['src/a.ts'] });
  expect(result.status).toBe('truncated');
  expect(result.diagnostics).toContain('tree limit');
});

it('prefers exact import paths and reports ambiguous extension fallbacks', async () => {
  const result = await new TypeScriptTestDiscovery().discover({
    repository: repository({
      'src/value.js': '', 'src/value.ts': '', 'src/value/index.ts': '',
      'tests/value.test.ts': "import '../src/value.js'; import '../src/value';",
    }),
    headSha: 'head', sourcePaths: ['src/value.ts', 'src/value/index.ts', 'src/value.js'],
  });
  const candidate = result.candidates[0];
  expect(candidate?.relationships.filter((signal) => signal.type === 'static-import')).toEqual([
    { type: 'static-import', sourcePath: 'src/value.js' },
    { type: 'static-import', sourcePath: 'src/value.ts' },
    { type: 'static-import', sourcePath: 'src/value/index.ts' },
  ]);
  expect(candidate?.uncertainty).toContain('Static import "../src/value" ambiguously matches src/value.ts, src/value/index.ts, src/value.js');
});
