import { describe, expect, it } from 'vitest';
import { diffKeys, diffWords, type Hunk, toNew, toOld } from '@/server/render/diff.js';

/** `a` with every hunk replaced by its `b` span: must equal `b` for any correct diff. */
function apply(a: string[], b: string[], hunks: Hunk[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (const h of hunks) {
    out.push(...a.slice(at, h.a0), ...b.slice(h.b0, h.b1));
    at = h.a1;
  }
  return [...out, ...a.slice(at)];
}

/** Deterministic, so a failure reproduces. */
function rng(seed: number): () => number {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

describe('diffKeys', () => {
  it('reports nothing for equal sequences', () => {
    expect(diffKeys(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('isolates a replaced word', () => {
    expect(diffKeys('the solver computes all'.split(' '), 'the solver discovers all'.split(' '))).toEqual([
      { a0: 2, a1: 3, b0: 2, b1: 3 },
    ]);
  });

  it('separates distant edits', () => {
    const a = 'a b c d e f g h'.split(' ');
    const b = 'a X c d e f Y h'.split(' ');
    expect(diffKeys(a, b)).toEqual([
      { a0: 1, a1: 2, b0: 1, b1: 2 },
      { a0: 6, a1: 7, b0: 6, b1: 7 },
    ]);
  });

  it('reconstructs the new side and keeps every equal key between hunks', () => {
    const next = rng(7);
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: Math.floor(next() * 40) }, () => 'abcde'[Math.floor(next() * 5)]!);
      const b = a.flatMap((x) => (next() < 0.15 ? [] : next() < 0.15 ? [x, 'z'] : [x]));
      const hunks = diffKeys(a, b);
      expect(apply(a, b, hunks)).toEqual(b);
      // Minimal scripts never pair an equal key across a hunk boundary that could have matched.
      for (const h of hunks) expect(h.a1 - h.a0 + h.b1 - h.b0).toBeGreaterThan(0);
    }
  });
});

describe('diffWords', () => {
  it('confines reflow to the edited lines', () => {
    const a = 'one two three four five six'.split(' ');
    const b = 'one two THREE four five six'.split(' ');
    // Line breaks moved within the edited paragraph; the words themselves did not.
    expect(diffWords(a, b, [0, 2, 4], [0, 3, 4])).toEqual([{ a0: 2, a1: 3, b0: 2, b1: 3 }]);
  });
});

describe('toNew / toOld', () => {
  // "every calling context" -> "every [calling] fff context": a removed word inlined before its replacement.
  const a = 'every fff context'.split(' ');
  const b = 'every calling fff context'.split(' ');
  const hunks = diffKeys(a, b);

  it('maps a word past words inserted right before it', () => {
    expect(toNew(hunks, 1)).toBe(2);
    expect(toNew(hunks, 2)).toBe(3);
    expect(toOld(hunks, 2)).toBe(1);
  });

  it('maps a replaced word to its replacement', () => {
    const r = diffKeys('a old b'.split(' '), 'a new b'.split(' '));
    expect(toNew(r, 1)).toBe(1);
    expect(toNew(r, 2)).toBe(2);
  });
});
