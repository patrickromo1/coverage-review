import { afterEach, expect, it, vi } from 'vitest';
import { executeOpenAISdk } from '../../src/agent/openai/sdk-execution.js';
import { OpenAIConfigSchema, type SdkExecutionRequest } from '../../src/agent/openai/openai-review-agent.js';
import { AgentFailure } from '../../src/agent/failure.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const output = { schemaVersion: '1', summary: 'SDK response', analysisStatus: 'partial', reviewedFiles: [], limitations: ['Limited'], findings: [] };
function response(items: unknown[]) {
  return new Response(JSON.stringify({ id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model: 'test',
    output: items, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }), { headers: { 'content-type': 'application/json' } });
}
function message(content: unknown[]) { return { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content }; }
function request(): SdkExecutionRequest {
  return { config: OpenAIConfigSchema.parse({ model: 'test', maxTurns: 2 }), instructions: 'PRIVATE_PROMPT', input: 'PRIVATE_SOURCE',
    signal: new AbortController().signal, inspect: vi.fn(async () => ({ status: 'available', content: 'PRIVATE_TOOL', references: [] })) };
}
it('runs the installed SDK with strict structured output, private defaults, no retries, and no trace requests', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'FAKE_TEST_KEY');
  const fetch = vi.fn(async () => response([message([{ type: 'output_text', text: JSON.stringify(output), annotations: [] }])]));
  vi.stubGlobal('fetch', fetch);
  const result = await executeOpenAISdk(request());
  expect(result.output).toEqual(output); expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, requests: 1 });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
  expect(String(url)).toBe('https://api.openai.com/v1/responses');
  const body = JSON.parse(init.body as string);
  expect(body).toMatchObject({ model: 'test', store: false, parallel_tool_calls: false, max_output_tokens: 4096 });
  expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
  expect(body.tools).toHaveLength(1); expect(body.tools[0].name).toBe('inspect_evidence');
  expect(body.text.format.schema.required).toContain('findings');
});
it.each([[401, 'authentication'], [403, 'authentication'], [429, 'rate-limit'], [500, 'provider-error']] as const)('maps HTTP %s without echoing payloads or retrying', async (status, code) => {
  vi.stubEnv('OPENAI_API_KEY', 'FAKE_TEST_KEY');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'SENSITIVE_PROVIDER_PAYLOAD', type: 'error' } }), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  await expect(executeOpenAISdk(request())).rejects.toMatchObject({ code, message: `Review agent failed: ${code}.` });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('recognizes SDK refusal and invalid JSON output', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'FAKE_TEST_KEY');
  vi.stubGlobal('fetch', vi.fn(async () => response([message([{ type: 'refusal', refusal: 'PRIVATE_REFUSAL' }])])));
  await expect(executeOpenAISdk(request())).rejects.toMatchObject({ code: 'refusal' });
  vi.stubGlobal('fetch', vi.fn(async () => response([message([{ type: 'output_text', text: 'not json', annotations: [] }])])));
  await expect(executeOpenAISdk(request())).rejects.toMatchObject({ code: 'invalid-proposal' });
});
it('enforces max turns and does not reexecute the same SDK tool call ID', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'FAKE_TEST_KEY');
  const fetch = vi.fn(async () => response([{ type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'inspect_evidence',
    arguments: JSON.stringify({ kind: 'source', file: 'a.ts', side: 'head', testPath: null, startLine: 1, lineCount: 10 }), status: 'completed' }]));
  vi.stubGlobal('fetch', fetch);
  const input = request();
  await expect(executeOpenAISdk(input)).rejects.toMatchObject({ code: 'budget-exhausted' });
  expect(fetch).toHaveBeenCalledTimes(2); expect(input.inspect).toHaveBeenCalledTimes(1);
});
it.each(['budget-exhausted', 'invalid-proposal'] as const)('preserves wrapped SDK tool failure category %s', async (code) => {
  vi.stubEnv('OPENAI_API_KEY', 'FAKE_TEST_KEY');
  const fetch = vi.fn(async () => response([{ type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'inspect_evidence',
    arguments: JSON.stringify({ kind: 'source', file: 'a.ts', side: 'head', testPath: null, startLine: 1, lineCount: 10 }), status: 'completed' }]));
  vi.stubGlobal('fetch', fetch);
  const input = request();
  input.inspect = vi.fn(async () => { throw new AgentFailure(code); });
  await expect(executeOpenAISdk(input)).rejects.toMatchObject({ code, message: `Review agent failed: ${code}.` });
  expect(fetch).toHaveBeenCalledTimes(1); expect(input.inspect).toHaveBeenCalledTimes(1);
});
it('does no IO for absent credentials or pre-aborted work', async () => {
  vi.stubEnv('OPENAI_API_KEY', ''); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(executeOpenAISdk(request())).rejects.toMatchObject({ code: 'authentication' });
  const input = request(); input.signal = AbortSignal.abort();
  await expect(executeOpenAISdk(input)).rejects.toMatchObject({ code: 'timeout' });
  expect(fetch).not.toHaveBeenCalled();
});

it('propagates cancellation into the actual SDK HTTP request', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'FAKE_TEST_KEY');
  const controller = new AbortController();
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const signal = init.signal!;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
      controller.abort();
    });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(executeOpenAISdk({ ...request(), signal: controller.signal })).rejects.toMatchObject({ code: 'timeout' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
