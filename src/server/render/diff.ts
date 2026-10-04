/** A replaced span: `a[a0, a1)` became `b[b0, b1)`. Either side may be empty. */
export interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** Edit distance past which Myers gives up and reports the remaining middle as one replaced span. */
const MAX_EDITS = 2000;

/**
 * Myers' shortest edit script between two key sequences, as hunks in order. The common prefix and
 * suffix are trimmed first, so a local edit in a long document costs only its own distance.
 */
export function diffKeys(a: readonly string[], b: readonly string[]): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  if (start === endA || start === endB) return [{ a0: start, a1: endA, b0: start, b1: endB }];
  return myers(a, b, start, endA, start, endB);
}

function myers(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number): Hunk[] {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // v as it stood before each round d, for walking the path back.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return [{ a0, a1, b0, b1 }];

  // Walk back from (n, m): each round is one insertion or deletion plus the diagonal run before it.
  const edits: Array<{ x: number; y: number; del: boolean }> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    // trace[d] starts at diagonal -d - 1.
    const at = (k: number) => prev[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > (down ? px : px + 1) && y > (down ? py + 1 : py)) {
      x--;
      y--;
    }
    edits.push({ x: px, y: py, del: !down });
    x = px;
    y = py;
  }
  edits.reverse();

  const hunks: Hunk[] = [];
  for (const e of edits) {
    const ax = a0 + e.x;
    const by = b0 + e.y;
    const last = hunks[hunks.length - 1];
    const touches = last && last.a1 === ax && last.b1 === by;
    const h = touches ? last : { a0: ax, a1: ax, b0: by, b1: by };
    if (e.del) h.a1++;
    else h.b1++;
    if (!touches) hunks.push(h);
  }
  return hunks;
}

/**
 * Hunks between two word sequences grouped into lines: lines are aligned first, then words inside each
 * replaced block of lines. Pagination and reflow outside an edit never reach the word diff, and the
 * word diff stays small enough for Myers on any document length.
 */
export function diffWords(
  a: readonly string[],
  b: readonly string[],
  aLines: readonly number[],
  bLines: readonly number[],
): Hunk[] {
  const lineKeys = (keys: readonly string[], starts: readonly number[]) =>
    starts.map((s, i) => keys.slice(s, starts[i + 1] ?? keys.length).join(' '));
  const at = (starts: readonly number[], keys: readonly string[], i: number) => starts[i] ?? keys.length;
  const out: Hunk[] = [];
  for (const block of diffKeys(lineKeys(a, aLines), lineKeys(b, bLines))) {
    const wa0 = at(aLines, a, block.a0);
    const wa1 = at(aLines, a, block.a1);
    const wb0 = at(bLines, b, block.b0);
    const wb1 = at(bLines, b, block.b1);
    for (const h of diffKeys(a.slice(wa0, wa1), b.slice(wb0, wb1)))
      out.push({ a0: wa0 + h.a0, a1: wa0 + h.a1, b0: wb0 + h.b0, b1: wb0 + h.b1 });
  }
  return out;
}

/**
 * Where word `i` of `a` lands in `b`: shifted past every hunk before it, including words inserted
 * right before it, or to its hunk's start when the hunk replaced or removed it.
 */
export function toNew(hunks: readonly Hunk[], i: number): number {
  let shift = 0;
  for (const h of hunks) {
    if (h.a0 > i || (h.a0 === i && h.a1 > h.a0)) break;
    if (h.a1 > i) return h.b0;
    shift = h.b1 - h.a1;
  }
  return i + shift;
}

/** `toNew` the other way: where word `i` of `b` came from in `a`. */
export function toOld(hunks: readonly Hunk[], i: number): number {
  let shift = 0;
  for (const h of hunks) {
    if (h.b0 > i || (h.b0 === i && h.b1 > h.b0)) break;
    if (h.b1 > i) return h.a0;
    shift = h.a1 - h.b1;
  }
  return i + shift;
}
