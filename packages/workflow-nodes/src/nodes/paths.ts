/** Dot-path access for record transformation. No expression evaluation. */
export function getPath(value: unknown, path: string): unknown {
  if (path === '' || path === '.') return value;
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i] as string;
    if (typeof cur[s] !== 'object' || cur[s] === null) cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1] as string] = value;
}
