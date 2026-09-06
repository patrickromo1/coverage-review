/** Bounded JSON preflight also rejects duplicate object keys before JSON.parse can overwrite them. */
export function parseBoundedJson(content: string, maxBytes = 16 * 1024 * 1024): unknown {
  if (Buffer.byteLength(content) > maxBytes) throw new Error('JSON byte budget exhausted');
  const stack: Array<Set<string> | null> = [];
  let records = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      const start = i++;
      for (; i < content.length; i++) { if (content[i] === '\\') i++; else if (content[i] === '"') break; }
      let next = i + 1;
      while (/\s/.test(content[next] ?? '') && next < content.length) next++;
      if (content[next] === ':') {
        const keys = stack.at(-1);
        if (!keys) throw new Error('Invalid JSON object');
        const key = JSON.parse(content.slice(start, i + 1)) as string;
        if (keys.has(key)) throw new Error('Duplicate JSON key');
        keys.add(key);
      }
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? new Set() : null);
      if (stack.length > 16) throw new Error('JSON nesting budget exhausted');
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && ++records > 400_000) throw new Error('JSON record budget exhausted');
  }
  return JSON.parse(content) as unknown;
}
