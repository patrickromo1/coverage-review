import { z } from 'zod';
import { assertRepositoryPath } from '../repository/repository.js';
const path = z.string().min(1).max(4096).refine((value) => {
  try { assertRepositoryPath(value); return true; } catch { return false; }
});
export const ReviewConfigSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  packages: z.array(z.strictObject({ root: path, sourceRoots: z.array(path).min(1).max(20) })).max(50).default([]),
  reports: z.array(z.strictObject({
    path, format: z.enum(['lcov', 'coverage-py-json']), root: path.optional(),
    commitSha: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).optional(),
  })).max(20).default([]),
}).superRefine((value, context) => {
  const roots = value.packages.map((pkg) => pkg.root);
  if (roots.some((root, index) => roots.some((other, j) => index !== j && (root === other || root.startsWith(`${other}/`))))) {
    context.addIssue({ code: 'custom', message: 'Package roots must be unique and non-overlapping' });
  }
  const sourceRoots = value.packages.flatMap((pkg) => pkg.sourceRoots);
  if (sourceRoots.some((root, index) => sourceRoots.some((other, j) => index !== j && (root === other || root.startsWith(`${other}/`))))) context.addIssue({ code: 'custom', message: 'Source roots must be unique and non-overlapping' });
  for (const pkg of value.packages) if (pkg.sourceRoots.some((root) => root !== pkg.root && !root.startsWith(`${pkg.root}/`))) {
    context.addIssue({ code: 'custom', message: 'Source roots must be inside their package' });
  }
});
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export function packageFor(path: string, config: ReviewConfig): string | undefined {
  return config.packages.find((pkg) => path === pkg.root || path.startsWith(`${pkg.root}/`))?.root;
}
