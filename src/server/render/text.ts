import type { PdfRect } from '@/shared/protocol.js';

/** One word of a rendered page, in reading order. */
export interface PdfWord {
  text: string;
  /** Equality key for diffing and matching: see `wordKey`. */
  key: string;
  /** 1-based page of the word's first box. */
  page: number;
  /** One box per line the word sits on: two for a word hyphenated across a line break. */
  rects: PdfRect[];
}

/** The text of a rendered document, as diffing, anchoring and source mapping see it. */
export interface PdfText {
  /** Page sizes in PDF points. */
  pages: { width: number; height: number }[];
  words: PdfWord[];
  /** Outline entries in document order, each with the index of the first word at or below its destination. */
  headings: { title: string; word: number }[];
}

/**
 * NFKC folds math italics and ligatures to plain letters. Hyphens drop out: a PDF's text cannot tell a
 * typesetter's line-break hyphen from a compound's own, so "over-approx-imate" must equal "over-approximate".
 */
export function wordKey(text: string): string {
  return text.normalize('NFKC').replace(/[-\u00ad\u2010]/g, '');
}

/**
 * A word broken across a line: continued in lowercase on the next line, after either a visible hyphen or
 * a hidden glyph. A tagged PDF hides glyphs in a marked span without text: Typst draws every hyphen that
 * way, its line-break hyphens and a compound's own alike, so extraction never sees one. Either way the
 * halves join, and `wordKey` ignores whether a hyphen stays between them.
 */
const HYPHEN_END = /[-\u2010]$/;
const CONTINUES = /^\p{Ll}/u;

interface Char {
  ch: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

type TextItem = import('pdfjs-dist/types/src/display/api.js').TextItem;
type TextMarkedContent = import('pdfjs-dist/types/src/display/api.js').TextMarkedContent;

interface Line {
  chars: Char[];
  /** The line ended in a span that drew glyphs without text: a tagged hyphen. */
  silentEnd: boolean;
}

let loaded: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;

/**
 * pdf.js in Node: the worker module is installed on globalThis first, so pdf.js runs it on the main
 * thread instead of resolving a worker file the bundle does not ship.
 */
function pdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  loaded ??= (async () => {
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  return loaded;
}

/** Words, page sizes and outline of a PDF. Rejects when pdf.js cannot read it. */
export async function extractText(pdf: Uint8Array): Promise<PdfText> {
  const lib = await pdfjs();
  // pdf.js transfers the buffer it is given and refuses a Buffer; a plain copy leaves the caller's bytes intact.
  const task = lib.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages: PdfText['pages'] = [];
    const acc: Words = { out: [], hyphenated: null };
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      const size = { width: x1 - x0, height: y1 - y0 };
      pages.push(size);
      const content = await page.getTextContent({ includeMarkedContent: true });
      const lines = textLines(content.items, x0, y1);
      appendWords(acc, lines, n, size);
      page.cleanup();
    }
    const words = acc.out;
    const headings = await outline(doc, words, pages);
    return { pages, words, headings };
  } finally {
    await task.destroy();
  }
}

/**
 * Characters grouped into visual lines, each character placed by its share of the item's width: pdf.js
 * reports runs, not glyphs. Coordinates are points from the page's top left.
 */
function textLines(items: Array<TextItem | TextMarkedContent>, originX: number, top: number): Line[] {
  const lines: Line[] = [];
  let line: Char[] = [];
  let baseline: number | null = null;
  // Since the line's last text: whether a content span closed without any (at a line end, a hidden
  // hyphen), and whether one closed inside a run of text (mid-line, a hidden compound hyphen).
  let silent = false;
  let hidden = false;
  // Open marked spans: artifacts (decoration such as a strike-through) are never content.
  const spans: Array<{ artifact: boolean; text: boolean }> = [];
  const breakLine = () => {
    if (line.length) lines.push({ chars: line, silentEnd: silent });
    line = [];
    baseline = null;
    silent = false;
    hidden = false;
  };
  for (const item of items) {
    if (!('str' in item)) {
      if (item.type !== 'endMarkedContent')
        spans.push({ artifact: (item as { tag?: string }).tag === 'Artifact', text: false });
      else {
        const span = spans.pop();
        if (span && !span.artifact && !span.text) {
          silent = true;
          // Mid-line, only an empty span inside the text around it hides a glyph; one between spans is
          // structure, such as the end of an emphasis.
          if (spans[spans.length - 1]?.text) hidden = true;
        }
      }
      continue;
    }
    const [, , c = 0, d = 0, e = 0, f = 0] = item.transform;
    const size = Math.hypot(c, d) || 1;
    const y = top - f;
    if (item.str.length > 0) {
      if (baseline != null && Math.abs(y - baseline) > size * 0.3) breakLine();
      const last = line[line.length - 1];
      if (hidden && last) {
        // A hidden glyph inside a line (a tagged PDF's hyphen in "state-of-the-art") joins the runs
        // around it. The gap it leaves reads as a space, which would split one word into several.
        if (!item.str.trim()) continue;
        line.push({ ...last, ch: '-', x0: last.x1 });
      } else if (last && e - originX - last.x1 > size * 0.25) {
        // A run that starts well after the previous one ended is a new word even without a space.
        line.push(space(last));
      }
      for (const span of spans) span.text = true;
      silent = false;
      hidden = false;
      baseline ??= y;
      const chars = [...item.str];
      const unit = item.width / chars.reduce((sum, ch) => sum + advance(ch), 0);
      let x = e - originX;
      for (const ch of chars) {
        const w = advance(ch) * unit;
        line.push({ ch, x0: x, x1: x + w, top: y - size * 0.8, bottom: y + size * 0.2 });
        x += w;
      }
    }
    if (item.hasEOL) breakLine();
  }
  breakLine();
  return lines;
}

/**
 * A character's typical advance in a text face, in thousandths of an em (Times-like). pdf.js reports a
 * run's width, not its glyphs'; Typst emits a whole line as one run, so an even split would drift a box
 * by several characters across a line.
 */
const ADVANCE: Record<string, number> = {
  ...Object.fromEntries([...'fjlrt'].map((c) => [c, 300])),
  ...Object.fromEntries([..."iI.,;:!'|"].map((c) => [c, 270])),
  ...Object.fromEntries([...'acesz'].map((c) => [c, 430])),
  ...Object.fromEntries([...'mwMW'].map((c) => [c, 800])),
  ' ': 250,
  '-': 333,
};

function advance(ch: string): number {
  return ADVANCE[ch] ?? (/\p{Lu}/u.test(ch) ? 680 : 500);
}

function space(after: Char): Char {
  return { ...after, ch: ' ', x0: after.x1 };
}

/** Extraction state carried across pages: the word that ended a line with a hyphen, if any. */
interface Words {
  out: PdfWord[];
  hyphenated: PdfWord | null;
}

function appendWords(acc: Words, lines: Line[], page: number, size: { width: number; height: number }): void {
  const box = (chars: Char[]): PdfRect => {
    const x0 = Math.min(...chars.map((c) => c.x0));
    const x1 = Math.max(...chars.map((c) => c.x1));
    const t = Math.min(...chars.map((c) => c.top));
    const b = Math.max(...chars.map((c) => c.bottom));
    return { page, x: x0 / size.width, y: t / size.height, w: (x1 - x0) / size.width, h: (b - t) / size.height };
  };
  for (const line of lines) {
    let run: Char[] = [];
    const flush = (atLineEnd: boolean) => {
      if (!run.length) return;
      const text = run.map((c) => c.ch).join('');
      const prev = acc.hyphenated;
      acc.hyphenated = null;
      // The second half of a hyphenated word joins the first, so reflow does not read as an edit.
      if (prev && CONTINUES.test(text)) {
        prev.text += text;
        prev.key = wordKey(prev.text);
        prev.rects.push(box(run));
      } else {
        const word: PdfWord = { text, key: wordKey(text), page, rects: [box(run)] };
        if (atLineEnd && text.length > 1 && (HYPHEN_END.test(text) || (line.silentEnd && /\p{L}$/u.test(text))))
          acc.hyphenated = word;
        acc.out.push(word);
      }
      run = [];
    };
    for (const c of line.chars) {
      if (/\s/.test(c.ch)) flush(false);
      else run.push(c);
    }
    flush(true);
  }
}

type PdfDocument = Awaited<ReturnType<Awaited<ReturnType<typeof pdfjs>>['getDocument']>['promise']>;

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

/** Outline entries resolved to word indices; an entry whose destination cannot be resolved is left out. */
async function outline(doc: PdfDocument, words: PdfWord[], pages: PdfText['pages']): Promise<PdfText['headings']> {
  const nodes = ((await doc.getOutline()) ?? []) as OutlineNode[];
  const flat: OutlineNode[] = [];
  const walk = (list: OutlineNode[]) => {
    for (const n of list) {
      flat.push(n);
      walk(n.items ?? []);
    }
  };
  walk(nodes);
  const out: PdfText['headings'] = [];
  for (const node of flat) {
    try {
      const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest;
      if (!dest?.[0]) continue;
      const page = (await doc.getPageIndex(dest[0] as Parameters<PdfDocument['getPageIndex']>[0])) + 1;
      const size = pages[page - 1];
      const destTop = typeof dest[3] === 'number' && size ? 1 - dest[3] / size.height : 0;
      const word = words.findIndex(
        (w) => w.page > page || (w.page === page && w.rects[0]!.y + w.rects[0]!.h >= destTop),
      );
      if (word >= 0) out.push({ title: node.title, word });
    } catch {
      // A malformed destination only costs the section label.
    }
  }
  return out.sort((a, b) => a.word - b.word);
}
