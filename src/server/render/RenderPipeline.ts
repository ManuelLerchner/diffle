import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type {
  PdfRect,
  RenderedChange,
  RenderedDocument,
  RenderedSide,
  ServerMessage,
  Side,
  Snapshot,
} from '@/shared/protocol.js';
import { mapLimit } from '@/server/concurrency.js';
import type { Session } from '@/server/Session.js';
import { diffWords } from './diff.js';
import { spanRects } from './passage.js';
import type { Renderer } from './Renderer.js';
import { extractText, type PdfText } from './text.js';

/** One side, compiled and read, or why it could not be. */
type Outcome =
  | { state: 'ready'; key: string; pdf: Buffer; text: PdfText }
  | { state: 'failed'; message: string }
  | { state: 'absent' };

type Ready = Extract<Outcome, { state: 'ready' }>;

interface Rendered {
  snap: Snapshot;
  old: Outcome;
  new: Outcome;
  changes: RenderedChange[];
}

interface Broadcaster {
  broadcast(msg: ServerMessage): void;
}

/** Concurrent reads while copying one side's tree. */
const READ_CONCURRENCY = 8;
/** Renders kept by content: the two sides of the current snapshot and of the one before. */
const CACHE_SIZE = 4;

/**
 * A review's document, compiled by its `Renderer` on both sides of every snapshot. Each side is copied
 * out of the snapshot (the entry's directory, read through `Session.readSide`) into a temporary root,
 * so the compiler sees exactly the reviewed tree and never the checkout. Renders run one at a time,
 * newest snapshot first; a side whose files did not change is not compiled again.
 */
export class RenderPipeline {
  private current: Rendered | null = null;
  /** The snapshot waiting for the render in flight, if any. */
  private queued: Snapshot | null = null;
  private running = false;
  private drained: Promise<void> = Promise.resolve();
  private cache = new Map<string, Promise<Outcome>>();
  private latest: Snapshot | null = null;

  constructor(
    private readonly session: Session,
    private readonly hub: Broadcaster,
    /** Repository path of the entry file. */
    readonly entry: string,
    private readonly renderer: Renderer,
  ) {
    const dir = posix.dirname(entry);
    this.prefix = dir === '.' ? '' : `${dir}/`;
    session.onSnapshot((snap) => this.schedule(snap));
  }

  /** The entry's directory with a trailing slash, or '': each side is this subtree of the snapshot. */
  private readonly prefix: string;

  /** What the client shows now. */
  document(): RenderedDocument {
    const c = this.current;
    return {
      entry: this.entry,
      version: c?.snap.version ?? 0,
      rendering: this.running,
      old: c ? wire(c.old) : null,
      new: c ? wire(c.new) : null,
      changes: c?.changes ?? [],
    };
  }

  /** The PDF a side's key names, while that side is current. */
  pdf(side: Side, key: string): Buffer | null {
    const o = this.current?.[side];
    return o?.state === 'ready' && o.key === key ? o.pdf : null;
  }

  /** Resolves once no render is queued or running. */
  async settled(): Promise<void> {
    while (this.running) await this.drained;
  }

  private schedule(snap: Snapshot): void {
    this.latest = snap;
    this.queued = snap;
    if (this.running) return;
    this.running = true;
    this.hub.broadcast({ type: 'document' });
    this.drained = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued) {
        const snap = this.queued;
        this.queued = null;
        try {
          await this.render(snap);
        } catch (e) {
          console.error('[diffle] render failed:', e);
        }
      }
    } finally {
      this.running = false;
      this.hub.broadcast({ type: 'document' });
    }
  }

  private async render(snap: Snapshot): Promise<void> {
    const [old, next] = await Promise.all([this.side(snap, 'old'), this.side(snap, 'new')]);
    // A render of a comparison the session has left is no use to anyone.
    if (this.latest?.mode !== snap.mode) return;
    const prev = this.current;
    const same = prev?.old === old && prev.new === next;
    const changes =
      old.state === 'ready' && next.state === 'ready' ? (same ? prev.changes : changesBetween(old, next)) : [];
    this.current = { snap, old, new: next, changes };
    this.hub.broadcast({ type: 'document' });
  }

  /** One side's render, from the cache when its files are the ones last compiled. */
  private async side(snap: Snapshot, side: Side): Promise<Outcome> {
    const files = await this.files(snap, side);
    return files ? this.cached(files) : { state: 'absent' };
  }

  /** The render of exactly these files, compiled once per content. */
  private async cached(files: Map<string, Buffer>): Promise<Outcome> {
    const hash = createHash('sha256').update(`${await this.renderer.version()}\0${this.entry}\0`);
    for (const [path, buf] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      hash.update(`${path}\0${buf.length}\0`).update(buf);
    }
    const key = hash.digest('hex').slice(0, 32);
    let outcome = this.cache.get(key);
    if (!outcome) {
      outcome = this.compile(key, files);
      this.cache.set(key, outcome);
      while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    } else {
      // Refresh its place: a side in use must outlive older entries.
      this.cache.delete(key);
      this.cache.set(key, outcome);
    }
    return outcome;
  }

  /**
   * The files of the entry's directory on one side, keyed relative to it, or null when the entry is
   * not on that side. A rename's old side is written under its old path, as the compiler knew it then.
   */
  private async files(snap: Snapshot, side: Side): Promise<Map<string, Buffer> | null> {
    const prefix = this.prefix;
    const changed = new Map(snap.changed.map((f) => [f.path, f]));
    // [snapshot path, path on this side]
    const paths: Array<[string, string]> = [];
    for (const p of snap.tree) {
      const f = changed.get(p);
      if (side === 'old' && f?.status === 'A') continue;
      const named = side === 'old' ? (f?.oldPath ?? p) : p;
      if (named.startsWith(prefix)) paths.push([p, named]);
    }
    if (side === 'old')
      for (const f of snap.changed) if (f.status === 'D' && f.path.startsWith(prefix)) paths.push([f.path, f.path]);
    if (!paths.some(([, named]) => named === this.entry)) return null;
    const read = await mapLimit(paths, READ_CONCURRENCY, async ([p, named]) => {
      const buf = await this.session.readSide(snap, p, side);
      return [named.slice(prefix.length), buf] as const;
    });
    const out = new Map<string, Buffer>();
    for (const [rel, buf] of read) if (buf) out.set(rel, buf);
    return out.has(this.entry.slice(prefix.length)) ? out : null;
  }

  private async compile(key: string, files: Map<string, Buffer>): Promise<Outcome> {
    // realpath: the compiler reports resolved paths, and macOS links the temp directory elsewhere.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'diffle-render-')));
    try {
      for (const [rel, buf] of files) {
        const abs = join(root, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, buf);
      }
      const compiled = await this.renderer.compile(root, posix.basename(this.entry));
      if (!compiled.ok) return { state: 'failed', message: compiled.message };
      const text = await extractText(compiled.pdf).catch((e: Error) => e);
      if (text instanceof Error) return { state: 'failed', message: `cannot read the compiled PDF: ${text.message}` };
      return { state: 'ready', key, pdf: compiled.pdf, text };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function wire(o: Outcome): RenderedSide {
  if (o.state === 'ready') return { state: 'ready', key: o.key, pages: o.text.pages };
  return o;
}

/** Visual lines of a word list: the index of each line's first word. */
function lineStarts(text: PdfText): number[] {
  const starts: number[] = [];
  let prev: PdfRect | null = null;
  for (const [i, w] of text.words.entries()) {
    const r = w.rects[0]!;
    if (!prev || prev.page !== r.page || Math.abs(prev.y - r.y) > Math.min(prev.h, r.h) / 2) starts.push(i);
    prev = r;
  }
  return starts;
}

/** The words' boxes, or for no words a caret where they would go, so every change has a place to show. */
function rectsOrCaret(t: PdfText, start: number, end: number): PdfRect[] {
  if (start < end) return spanRects(t.words, { start, end });
  const before = t.words[start - 1]?.rects.at(-1);
  const after = t.words[start]?.rects[0];
  if (before) return [{ ...before, x: before.x + before.w, w: 0 }];
  return after ? [{ ...after, w: 0 }] : [];
}

function changesBetween(a: Ready, b: Ready): RenderedChange[] {
  const hunks = diffWords(
    a.text.words.map((w) => w.key),
    b.text.words.map((w) => w.key),
    lineStarts(a.text),
    lineStarts(b.text),
  );
  const text = (t: PdfText, start: number, end: number) =>
    t.words
      .slice(start, end)
      .map((w) => w.text)
      .join(' ');
  return hunks.map((h) => ({
    old: rectsOrCaret(a.text, h.a0, h.a1),
    new: rectsOrCaret(b.text, h.b0, h.b1),
    oldText: text(a.text, h.a0, h.a1),
    newText: text(b.text, h.b0, h.b1),
  }));
}
