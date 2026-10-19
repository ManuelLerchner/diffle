import { diffWords } from '@/server/render/diff.js';

/** A run of non-blank source text and where it starts. */
interface Token {
  text: string;
  at: number;
}

/** Whitespace-separated words, and the index of each line's first word. */
function tokens(source: string): { words: Token[]; lineStarts: number[] } {
  const words: Token[] = [];
  const lineStarts: number[] = [];
  let end = 0;
  for (const m of source.matchAll(/\S+/g)) {
    if (words.length === 0 || source.slice(end, m.index).includes('\n')) lineStarts.push(words.length);
    words.push({ text: m[0], at: m.index });
    end = m.index + m[0].length;
  }
  return { words, lineStarts };
}

/**
 * Removed source as a reader would see it: markup calls, labels, references and emphasis marks go,
 * their text stays. A heuristic, since the words are shown, not compiled.
 */
export function readable(source: string): string {
  return source
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/<[\p{L}\p{N}_:.-]+>/gu, ' ')
    .replace(/#[\p{L}_][\p{L}\p{N}_.-]*/gu, ' ')
    .replace(/@([\p{L}\p{N}_:.-]+)/gu, '$1')
    .replace(/[[\]{}*_$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A Typst string literal: only the backslash and the quote need escaping. */
function typstString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The markup that shows removed words in place: struck through and tinted, breakable across lines. A
 * code expression with a string argument, so the words cannot break the surrounding markup; the space
 * after it ends the expression before a following `[`, `(` or `.` could extend it.
 */
export function removedMarkup(text: string): string {
  return `#highlight(fill: rgb(255, 80, 80, 22%), strike(text(fill: rgb(165, 20, 25), ${typstString(text)}))) `;
}

/**
 * The new source with the old one's removed words put back where they were, as `removedMarkup`: what a
 * latexdiff-style document compiles from. Words are diffed line by line, then within changed lines, as
 * the rendered text is; a replacement shows its removed words before the ones that took their place.
 */
export function combineSource(oldSource: string, newSource: string): string {
  if (oldSource === newSource) return newSource;
  const a = tokens(oldSource);
  const b = tokens(newSource);
  const hunks = diffWords(
    a.words.map((w) => w.text),
    b.words.map((w) => w.text),
    a.lineStarts,
    b.lineStarts,
  );
  const lineStarts = new Set(b.lineStarts);
  let out = '';
  let from = 0;
  for (const h of hunks) {
    if (h.a0 === h.a1) continue;
    const first = a.words[h.a0]!;
    const last = a.words[h.a1 - 1]!;
    const shown = readable(oldSource.slice(first.at, last.at + last.text.length));
    if (!shown) continue;
    const at = b.words[h.b0]?.at ?? newSource.length;
    const lead = at === newSource.length && !/\s$/.test(newSource) ? ' ' : '';
    // Before a line's first word, the words get a line of their own: `=`, `-` or `+` there still opens a
    // heading or a list item, and the line keeps its indentation.
    const indent = lineStarts.has(h.b0) ? /[ \t]*$/.exec(newSource.slice(0, at))![0] : null;
    const markup = indent == null ? removedMarkup(shown) : `${removedMarkup(shown).trimEnd()}\n${indent}`;
    out += newSource.slice(from, at) + lead + markup;
    from = at;
  }
  return out + newSource.slice(from);
}
