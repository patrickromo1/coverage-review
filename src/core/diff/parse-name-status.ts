import type { ChangedFile, ChangeStatus } from './diff-provider.js';
import { assertRepositoryPath } from '../repository/repository.js';

/** Parses git diff --name-status -z; never split paths on whitespace. */
export function parseNameStatus(output: string): ChangedFile[] {
  if (!output) return [];
  if (!output.endsWith('\0')) throw new Error('Truncated Git name-status output');
  const fields = output.slice(0, -1).split('\0');
  const files: ChangedFile[] = [];
  const statuses: Record<string, ChangeStatus> = {
    A: 'added', M: 'modified', D: 'deleted', T: 'type-changed',
  };
  for (let i = 0; i < fields.length;) {
    const code = fields[i++];
    const path = fields[i++];
    if (!code || !path) throw new Error('Malformed Git name-status output');
    assertRepositoryPath(path);
    if (/^R\d{1,3}$/.test(code) && Number(code.slice(1)) <= 100) {
      const destination = fields[i++];
      if (!destination) throw new Error('Missing rename destination');
      assertRepositoryPath(destination);
      files.push({ status: 'renamed', path: destination, previousPath: path });
    } else {
      const status = statuses[code];
      if (!status) throw new Error(`Unsupported Git change status: ${code}`);
      files.push({ status, path });
    }
  }
  return files;
}
