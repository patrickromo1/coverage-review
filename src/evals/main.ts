import { parseArgs } from 'node:util';
import { OpenAIConfigSchema, OpenAIReviewAgent } from '../agent/openai/openai-review-agent.js';
import { ReviewLimitsSchema } from '../agent/review-agent.js';
import { loadSemanticSuite, runSemanticSuite } from './run-semantic.js';

try {
  const { values } = parseArgs({ options: {
    offline: { type: 'boolean' }, live: { type: 'boolean' }, model: { type: 'string' },
    fixtures: { type: 'string' }, repeats: { type: 'string', default: '1' }, concurrency: { type: 'string', default: '1' },
    'timeout-ms': { type: 'string', default: '30000' }, 'max-turns': { type: 'string', default: '8' },
    'max-tool-calls': { type: 'string', default: '30' }, help: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    process.stdout.write('pnpm eval:offline | pnpm eval:live --model <model-id> --fixtures <comma-separated-ids> [--repeats 1..5] [--concurrency 1..4] [--timeout-ms 30000] [--max-turns 8] [--max-tool-calls 30]\nLive mode sends selected fixture evidence to OpenAI and requires OPENAI_API_KEY.\n');
  } else {
    if (!!values.live === !!values.offline) throw new Error('Choose exactly one of --offline or --live');
    if (values.offline && values.model) throw new Error('--model requires --live');
    if (values.live && (!values.model || !values.fixtures)) throw new Error('--live requires --model and bounded --fixtures selection');
    const suite = await loadSemanticSuite();
    const limits = ReviewLimitsSchema.parse({ timeoutMs: Number(values['timeout-ms']) });
    const config = values.live ? OpenAIConfigSchema.parse({ model: values.model, maxTurns: Number(values['max-turns']), maxToolCalls: Number(values['max-tool-calls']) }) : undefined;
    const report = await runSemanticSuite(suite, { ids: values.fixtures?.split(',') ?? suite.fixtures.map((fixture) => fixture.id),
      repeats: Number(values.repeats), concurrency: Number(values.concurrency), limits,
      mode: values.live ? 'live' : 'offline', ...(config ? { model: config.model, providerConfig: config,
        createAgent: () => new OpenAIReviewAgent(config, async (request) => (await import('../agent/openai/sdk-execution.js')).executeOpenAISdk(request)) } : {}),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} catch { process.stderr.write('Semantic eval configuration or execution failed; no provider payloads are printed.\n'); process.exitCode = 1; }
