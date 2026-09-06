import { appendFile } from 'node:fs/promises';

export const ACTION_OUTPUT_KEYS = ['verdict', 'analysis-status', 'findings-count', 'rejected-findings-count', 'result-path', 'reviewed-base-sha', 'reviewed-head-sha', 'publishing-status'] as const;
export type ActionOutputKey = typeof ACTION_OUTPUT_KEYS[number];

export function encodeActionOutput(key: ActionOutputKey, value: string | number): string {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error(`GitHub output ${key} must be a single line`);
  return `${key}=${text}\n`;
}

export async function writeActionOutputs(path: string, values: Readonly<Record<ActionOutputKey, string | number>>): Promise<void> {
  const content = ACTION_OUTPUT_KEYS.map((key) => encodeActionOutput(key, values[key])).join('');
  await appendFile(path, content, { encoding: 'utf8' });
}
