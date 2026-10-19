import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type {
  PdfAnchor,
  PdfRect,
  PdfThreadCreate,
  RenderedChange,
  RenderedDocument,
  RenderedSide,
  ServerMessage,
  Side,
  Snapshot,
  Surface,
} from '@/shared/protocol.js';
import { UnquotableError } from '@/server/comments/CommentStore.js';
import { mapLimit } from '@/server/concurrency.js';
import type { Session } from '@/server/Session.js';
import { diffWords, type Hunk, toNew, toOld } from './diff.js';
import { findPassage, firstWordOn, sectionOf, selectionKeys, sourceOf, type Span, spanRects } from './passage.js';
import { extractText, type PdfText } from './text.js';
import type { Renderer, SourceToken } from './Renderer.js';
import { Workspace } from './Workspace.js';

/** One side, compiled and read, or why it could not be. */
type Outcome =
  | { state: 'ready'; key: string; pdf: Buffer; text: PdfText; sources: Map<string, SourceToken[]> }
  /** `file`: the source the first error is in, when the renderer could tell. */
  | { state: 'failed'; message: string; file?: string }
  | { state: 'absent' };

type Ready = Extract<Outcome, { state: 'ready' }>;

interface Rendered {
  snap: Snapshot;
  old: Outcome;
  new: Outcome;
  /** Word hunks from the old side's words to the new side's; empty unless both are ready. */
  hunks: Hunk[];
  changes: RenderedChange[];
  /**
   * The new side with the old side's removed words typeset in place; null without changes, undefined
   * while it is still to be compiled.
   */
  combined: Outcome | null | undefined;
  /** Word hunks from the new side's words to the combined one's: the removed words it adds. */
  inlined: Hunk[];
}

/** One side's files, keyed relative to the entry's directory, and their render. */
interface SideRender {
  files: Map<string, Buffer> | null;
  outcome: Outcome;
}

interface Broadcaster {
  broadcast(msg: ServerMessage): void;
}

/** Concurrent reads while copying one side's tree. */
const READ_CONCURRENCY = 8;
/** Renders kept by content: the two sides and the combined render, of the current snapshot and the one before. */
const CACHE_SIZE = 6;

/**
 * A review's document, compiled by its `Renderer` on both sides of every snapshot. Each side is copied
 * out of the snapshot (the entry's directory, read through `Session.readSide`) into a temporary root,
 * so the compiler sees exactly the reviewed tree and never the checkout. Each surface keeps its root
 * for the run, so a compiler watching it sees an edit as one changed file. Renders run one at a time,
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
  private workspaces = new Map<Surface, Promise<Workspace>>();
  private closed = false;

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
      combined: c?.combined ? wire(c.combined) : null,
      combinedThreads: c ? this.combinedThreads(c) : {},
    };
  }

  /** New-side passages carried through the removed words the combined render adds. */
  private combinedThreads(c: Rendered): Record<string, PdfRect[]> {
    if (c.combined?.state !== 'ready') return {};
    const out: Record<string, PdfRect[]> = {};
    for (const t of this.session.comments.threads()) {
      const a = t.anchor;
      if (a.kind !== 'pdf' || a.side !== 'new' || t.stale) continue;
      const n = selectionKeys(a.quoted).length;
      if (n === 0) continue;
      const start = toNew(c.inlined, a.offset);
      out[t.id] = spanRects(c.combined.text.words, { start, end: toNew(c.inlined, a.offset + n - 1) + 1 });
    }
    return out;
  }

  /** The PDF a surface's key names, while that surface is current. */
  pdf(surface: Surface, key: string): Buffer | null {
    const o = this.current?.[surface];
    return o?.state === 'ready' && o.key === key ? o.pdf : null;
  }

  /** Resolves once no render is queued or running. */
  async settled(): Promise<void> {
    while (this.running) await this.drained;
  }

  /**
   * Places a selection as an anchor in the current render. Throws UnquotableError when that side is
   * not rendered or does not contain the text.
   */
  place(t: PdfThreadCreate): PdfAnchor {
    const o = this.current?.[t.side];
    if (o?.state !== 'ready') throw new UnquotableError(`the ${t.side} side of ${this.entry} is not rendered`);
    if (t.combined) return this.placeCombined(t, o);
    const span = findPassage(o.text.words, selectionKeys(t.quoted), firstWordOn(o.text.words, t.page));
    if (!span) throw new UnquotableError(`the ${t.side} render of ${this.entry} does not contain the selection`);
    return this.anchorAt(o, t.side, span);
  }

  /** A selection on the combined render, anchored on the new-side words it covers. */
  private placeCombined(t: PdfThreadCreate, now: Ready): PdfAnchor {
    const c = this.current!;
    if (t.side !== 'new' || c.combined?.state !== 'ready')
      throw new UnquotableError(`the combined render of ${this.entry} is not current`);
    const words = c.combined.text.words;
    const span = findPassage(words, selectionKeys(t.quoted), firstWordOn(words, t.page));
    if (!span) throw new UnquotableError(`the combined render of ${this.entry} does not contain the selection`);
    const start = toOld(c.inlined, span.start);
    const end = toOld(c.inlined, span.end - 1) + 1;
    // Only removed words: they have no place on the new side to anchor to.
    if (end <= start || selectionKeys(t.quoted).length === 0)
      throw new UnquotableError('select words of the new version; removed words have nowhere to anchor');
    return this.anchorAt(now, 'new', { start, end });
  }

  /**
   * The anchor's passage in the current render: moved, null when the text is gone, or undefined
   * when its side did not render, which says nothing about the passage.
   */
  relocate(anchor: PdfAnchor): PdfAnchor | null | undefined {
    const o = this.current?.[anchor.side];
    if (!o || o.state === 'failed') return undefined;
    if (o.state === 'absent') return null;
    const span = findPassage(o.text.words, selectionKeys(anchor.quoted), anchor.offset);
    return span && this.anchorAt(o, anchor.side, span);
  }

  private anchorAt(o: Ready, side: Side, span: Span): PdfAnchor {
    const words = o.text.words;
    const quoted = words
      .slice(span.start, span.end)
      .map((w) => w.text)
      .join(' ');
    const anchor: PdfAnchor = {
      kind: 'pdf',
      path: this.entry,
      side,
      quoted,
      offset: span.start,
      page: (words[span.start] ?? words[span.start - 1])?.page ?? 1,
      rects: rectsOrCaret(o.text, span.start, span.end),
    };
    const source = sourceOf(quoted, o.sources);
    if (source) anchor.source = source;
    const section = sectionOf(o.text, span.start);
    if (section) anchor.section = section;
    return anchor;
  }

  /** Stops rendering: compilers stop, and the temporary roots are removed once the render in flight ends. */
  async close(): Promise<void> {
    this.closed = true;
    this.queued = null;
    await this.renderer.close?.();
    await this.settled();
    await Promise.all([...this.workspaces.values()].map(async (ws) => (await ws).remove()));
  }

  private schedule(snap: Snapshot): void {
    if (this.closed) return;
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
    const [a, b] = await Promise.all([this.side(snap, 'old'), this.side(snap, 'new')]);
    const old = a.outcome;
    const next = b.outcome;
    // A render of a comparison the session has left is no use to anyone.
    if (this.latest?.mode !== snap.mode) return;
    const prev = this.current;
    if (prev?.old === old && prev.new === next) {
      this.current = { ...prev, snap };
    } else if (old.state === 'ready' && next.state === 'ready') {
      const { hunks, changes } = changesBetween(old, next);
      const combined = hunks.length && this.renderer.inline ? undefined : null;
      this.current = { snap, old, new: next, hunks, changes, combined, inlined: [] };
    } else {
      this.current = { snap, old, new: next, hunks: [], changes: [], combined: null, inlined: [] };
    }
    if (await this.session.comments.relocatePdf((anchor) => this.relocate(anchor)))
      this.hub.broadcast({ type: 'threads' });
    this.hub.broadcast({ type: 'document' });
    // The sides show first. The combined render, another compile, follows unless a newer snapshot waits:
    // its render then picks the combined one up, from here if the sides stay the same.
    const c = this.current;
    if (c.combined !== undefined || c.new.state !== 'ready' || this.queued || !a.files || !b.files) return;
    const combined = await this.combine(a.files, b.files);
    if (this.current !== c) return;
    const inlined = combined?.state === 'ready' ? alignWords(c.new.text, combined.text) : [];
    if (combined?.state === 'ready') placeInline(c.changes, c.hunks, inlined, combined.text);
    this.current = { ...c, combined, inlined };
    this.hub.broadcast({ type: 'document' });
  }

  /** One side's render, from the cache when its files are the ones last compiled. */
  private async side(snap: Snapshot, side: Side): Promise<SideRender> {
    const files = await this.files(snap, side);
    return { files, outcome: files ? await this.cached(files, side) : { state: 'absent' } };
  }

  /**
   * The new side with the old side's removed words put back into each changed source file and
   * compiled, when the renderer can. A file whose insertions the compiler refuses (they landed in code
   * or math, or broke markup another file relies on) goes back to its new text and the rest compile
   * again; with every file refused, the last failure stands for the combined render.
   */
  private async combine(oldFiles: Map<string, Buffer>, newFiles: Map<string, Buffer>): Promise<Outcome | null> {
    if (!this.renderer.inline) return null;
    const files = new Map(newFiles);
    const touched = new Set<string>();
    for (const [rel, buf] of newFiles) {
      const was = oldFiles.get(rel);
      if (!was || was.equals(buf)) continue;
      const combined = this.renderer.inline(rel, was.toString('utf8'), buf.toString('utf8'));
      if (combined == null || combined === buf.toString('utf8')) continue;
      files.set(rel, Buffer.from(combined, 'utf8'));
      touched.add(rel);
    }
    // Only additions: the new render already shows everything.
    if (touched.size === 0) return null;
    // The new side compiles, so a failure lies in the group just added. An error located elsewhere (a
    // template tripping over a heading the insertions unmade) names no file: halve the group to find it.
    const accepted = new Map(newFiles);
    let last: Outcome | null = null;
    const add = async (group: string[]): Promise<void> => {
      if (group.length === 0) return;
      const trial = new Map(accepted);
      for (const rel of group) trial.set(rel, files.get(rel)!);
      const outcome = await this.cached(trial, 'combined');
      if (outcome.state !== 'failed' || last?.state !== 'ready') last = outcome;
      if (outcome.state === 'ready') return void group.forEach((rel) => accepted.set(rel, files.get(rel)!));
      if (outcome.state === 'failed' && outcome.file && group.includes(outcome.file))
        return add(group.filter((rel) => rel !== outcome.file));
      if (group.length === 1) return;
      const half = Math.ceil(group.length / 2);
      await add(group.slice(0, half));
      await add(group.slice(half));
    };
    await add([...touched]);
    return last;
  }

  /** The render of exactly these files, compiled once per content, in `surface`'s root when it is not cached. */
  private async cached(files: Map<string, Buffer>, surface: Surface): Promise<Outcome> {
    const hash = createHash('sha256').update(`${await this.renderer.version()}\0${this.entry}\0`);
    for (const [path, buf] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      hash.update(`${path}\0${buf.length}\0`).update(buf);
    }
    const key = hash.digest('hex').slice(0, 32);
    let outcome = this.cache.get(key);
    if (!outcome) {
      outcome = this.compile(key, files, surface);
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

  private async compile(key: string, files: Map<string, Buffer>, surface: Surface): Promise<Outcome> {
    let ws = this.workspaces.get(surface);
    if (!ws) this.workspaces.set(surface, (ws = Workspace.create()));
    const workspace = await ws;
    const compiled = await this.renderer.compile(workspace.root, posix.basename(this.entry), () =>
      workspace.sync(files),
    );
    if (!compiled.ok)
      return { state: 'failed', message: compiled.message, ...(compiled.file ? { file: compiled.file } : {}) };
    const text = await extractText(compiled.pdf).catch((e: Error) => e);
    if (text instanceof Error) return { state: 'failed', message: `cannot read the compiled PDF: ${text.message}` };
    // Only the files the document read, when the compiler said; else every file it could have.
    const read = compiled.inputs.length ? compiled.inputs : [...files.keys()];
    const sources = new Map(
      read.flatMap((rel) => {
        const buf = files.get(rel);
        const tokens = buf && this.renderer.proseTokens(rel, buf.toString('utf8'));
        return tokens ? [[this.prefix + rel, tokens] as const] : [];
      }),
    );
    return { state: 'ready', key, pdf: compiled.pdf, text, sources };
  }
}

function wire(o: Outcome): RenderedSide {
  if (o.state === 'ready') return { state: 'ready', key: o.key, pages: o.text.pages };
  return o.state === 'failed' ? { state: 'failed', message: o.message } : o;
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

/** Hunks between two renders of mostly the same words, aligned line by line as the change diff is. */
function alignWords(a: PdfText, b: PdfText): Hunk[] {
  return diffWords(
    a.words.map((w) => w.key),
    b.words.map((w) => w.key),
    lineStarts(a),
    lineStarts(b),
  );
}

/** Each change's place in the combined render, found through the new side's words: `inlined` maps them over. */
function placeInline(changes: RenderedChange[], hunks: readonly Hunk[], inlined: readonly Hunk[], t: PdfText): void {
  hunks.forEach((h, i) => {
    const added = toNew(inlined, h.b0);
    const end = h.b1 > h.b0 ? toNew(inlined, h.b1 - 1) + 1 : added;
    // The removed words sit just before the added ones, after the last unchanged word.
    const start = Math.min(added, h.b0 > 0 ? toNew(inlined, h.b0 - 1) + 1 : 0);
    const change = changes[i]!;
    change.combined = end > added ? spanRects(t.words, { start: added, end }) : [];
    if (h.a1 > h.a0) change.inlined = added > start;
    const at = rectsOrCaret(t, start, Math.max(start + 1, end))[0];
    if (at) change.combinedAt = at;
  });
}

/**
 * Words of context tried around a change, widest first, so a one-word edit still traces to its source
 * line; narrower windows and one-sided ones keep a change near a heading or a file boundary traceable.
 */
const TRACE_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [6, 6],
  [3, 3],
  [6, 0],
  [0, 6],
  [3, 0],
  [0, 3],
  [0, 0],
];

function changesBetween(a: Ready, b: Ready): { hunks: Hunk[]; changes: RenderedChange[] } {
  const hunks = diffWords(
    a.text.words.map((w) => w.key),
    b.text.words.map((w) => w.key),
    lineStarts(a.text),
    lineStarts(b.text),
  );
  const text = (t: PdfText, start: number, end: number) =>
    t.words
      .slice(Math.max(0, start), end)
      .map((w) => w.text)
      .join(' ');
  const trace = (o: Ready, start: number, end: number) => {
    for (const [before, after] of TRACE_WINDOWS) {
      const found = sourceOf(text(o.text, start - before, end + after), o.sources);
      if (found) return found;
    }
    return null;
  };
  const changes = hunks.map((h): RenderedChange => {
    const change: RenderedChange = {
      old: rectsOrCaret(a.text, h.a0, h.a1),
      new: rectsOrCaret(b.text, h.b0, h.b1),
      oldText: text(a.text, h.a0, h.a1),
      newText: text(b.text, h.b0, h.b1),
    };
    const fromNew = trace(b, h.b0, h.b1);
    const fromOld = fromNew ? null : trace(a, h.a0, h.a1);
    if (fromNew) change.source = { ...fromNew, side: 'new' };
    else if (fromOld) change.source = { ...fromOld, side: 'old' };
    return change;
  });
  return { hunks, changes };
}
