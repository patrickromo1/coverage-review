import type { ReviewConfig } from '../config/review-config.js';
import { PythonTestDiscovery } from './python-test-discovery.js';
import { TypeScriptTestDiscovery, isTypeScriptOrJavaScript } from './typescript-test-discovery.js';
import type { TestDiscovery, TestDiscoveryRequest, TestDiscoveryResult } from './test-discovery.js';
export function isSupportedSource(path: string) { return isTypeScriptOrJavaScript(path) || path.endsWith('.py'); }
export class SupportedTestDiscovery implements TestDiscovery {
  constructor(private readonly config?: ReviewConfig) {}
  async discover(request: TestDiscoveryRequest): Promise<TestDiscoveryResult> {
    const results: TestDiscoveryResult[] = [];
    if (request.sourcePaths.some(isTypeScriptOrJavaScript)) results.push(await new TypeScriptTestDiscovery(2000, this.config).discover(request));
    request.signal?.throwIfAborted();
    if (request.sourcePaths.some((path) => path.endsWith('.py'))) results.push(await new PythonTestDiscovery(this.config).discover(request));
    return { status: results.some((value) => value.status !== 'available') ? 'truncated' : 'available',
      candidates: results.flatMap((value) => value.candidates).sort((a, b) => a.path < b.path ? -1 : 1), diagnostics: [...results.flatMap((value) => value.diagnostics), ...(this.config?.packages.length && request.sourcePaths.some((path) => !this.config!.packages.some((pkg) => pkg.sourceRoots.some((root) => path.startsWith(`${root}/`)))) ? ['Changed source falls outside configured source roots; discovery is uncertain'] : [])] };
  }
}
