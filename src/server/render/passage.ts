import type { PdfRect, SourceRange } from '@/shared/protocol.js';
import type { SourceToken } from './Renderer.js';
import { type PdfText, type PdfWord, wordKey } from './text.js';

/** A run of words: `[start, end)` into a side's word list. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Selected text as word keys. A selection in the browser's text layer breaks lines with a newline, and a
 * typesetter's hyphen before one belongs to no word, as in extraction.
 */
export function selectionKeys(quoted: string): string[] {
  return quoted
    .replace(/[-\u2010]\s*\n\s*(?=\p{Ll})/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(wordKey);
}

/**
 * Where `keys` occur in `words`, the occurrence starting nearest `near` first. A selection may start or
 * end inside a word, so its first key may be a word's tail and its last a word's head; the span covers
 * the whole words.
 */
export function findPassage(words: readonly PdfWord[], keys: readonly string[], near: number): Span | null {
  if (keys.length === 0) return null;
  const n = keys.length;
  const fits = (i: number) => {
    if (n === 1) return words[i]!.key.includes(keys[0]!);
    if (!words[i]!.key.endsWith(keys[0]!) || !words[i + n - 1]!.key.startsWith(keys[n - 1]!)) return false;
    for (let j = 1; j < n - 1; j++) if (words[i + j]!.key !== keys[j]) return false;
    return true;
  };
  let best: number | null = null;
  for (let i = 0; i + n <= words.length; i++) {
    if (fits(i) && (best == null || Math.abs(i - near) < Math.abs(best - near))) best = i;
  }
  return best == null ? null : { start: best, end: best + n };
}

/** The first word on `page`, or the word count past the last page: where a selection on that page starts its search. */
export function firstWordOn(words: readonly PdfWord[], page: number): number {
  const i = words.findIndex((w) => w.page >= page);
  return i < 0 ? words.length : i;
}

/** The words' boxes, merged per line: one rectangle per line a passage crosses. */
export function spanRects(words: readonly PdfWord[], span: Span): PdfRect[] {
  const out: PdfRect[] = [];
  for (const r of words.slice(span.start, span.end).flatMap((w) => w.rects)) {
    const last = out[out.length - 1];
    if (last && last.page === r.page && Math.abs(last.y - r.y) < Math.min(last.h, r.h) / 2) {
      const x1 = Math.max(last.x + last.w, r.x + r.w);
      const y1 = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = x1 - last.x;
      last.h = y1 - last.y;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** The title of the last outline entry at or before word `index`. */
export function sectionOf(text: PdfText, index: number): string | undefined {
  let title: string | undefined;
  for (const h of text.headings) {
    if (h.word > index) break;
    title = h.title;
  }
  return title;
}

/** Words of prose as source mapping compares them: letters and digits only, case-folded. */
const TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * The prose words of a text as tracing compares them, for rendered text and, once a renderer has
 * stripped the markup, for source. Hyphens join a word's parts, as in `wordKey`, so a compound reads
 * alike on both sides of a line break.
 */
export function proseWords(text: string): string[] {
  const joined = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?<=[\p{L}\p{N}])[-\u00ad\u2010]\s*(?=[\p{L}\p{N}])/gu, '');
  return [...joined.matchAll(TOKEN)].map((m) => m[0]);
}

/** Tokens a matching run must share at each end of the passage. */
const EDGE = 3;
/** How much longer than the passage its source may be: markup, math and macros between its words. */
const SLACK = 2;

/**
 * Where in the sources a passage of rendered text comes from, when exactly one place fits: its first and
 * last few prose tokens occur in one file in order, no further apart than the passage allows. Typesetting
 * rewrites text (math, smart quotes, macros, generated content), so no answer is the expected outcome for
 * much of a document, and the comment stays on the rendered passage.
 */
export function sourceOf(passage: string, sources: ReadonlyMap<string, SourceToken[]>): SourceRange | null {
  const tokens = proseWords(passage);
  if (tokens.length === 0) return null;
  const k = Math.min(EDGE, tokens.length);
  const head = tokens.slice(0, k);
  const tail = tokens.slice(-k);
  // A short passage is all edge: it must match whole, and a single word is too common to place.
  if (tokens.length < 2) return null;
  const reach = tokens.length * SLACK + 8;
  const hits: SourceRange[] = [];
  for (const [path, src] of sources) {
    const at = (i: number, run: string[]) => run.every((t, j) => src[i + j]?.token === t);
    for (let i = 0; i < src.length; i++) {
      if (!at(i, head)) continue;
      for (let e = i + Math.max(0, tokens.length - k); e < Math.min(src.length, i + reach); e++) {
        if (!at(e, tail)) continue;
        hits.push({ path, startLine: src[i]!.line, endLine: src[e + k - 1]!.line });
        break;
      }
      if (hits.length > 1) return null;
    }
  }
  return hits.length === 1 ? hits[0]! : null;
}
