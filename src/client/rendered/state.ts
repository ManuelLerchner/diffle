import { create } from 'zustand';
import type { CommentThread, PdfRect, RenderedDocument, Side } from '@/shared/protocol.js';
import { api } from '@/client/api.js';
import { useStore } from '@/client/store.js';

/** Text selected on a rendered page, waiting to become a comment. */
export interface PdfSelection {
  side: Side;
  /** 1-based page the selection starts on. */
  page: number;
  quoted: string;
  /** Viewport point under the selection's end, where the comment button and composer appear. */
  at: { x: number; y: number };
}

/** Where both columns scroll next: each side's rect lands at the gaze point; a new nonce lands it again. */
export interface RenderedJump {
  old?: PdfRect;
  new?: PdfRect;
  nonce: number;
}

/** What the center pane shows: the source diff, the rendered document, or both side by side. */
export type RenderedView = 'source' | 'rendered' | 'both';

export interface RenderedState {
  /** The `--typst` document; null when the review renders none. */
  doc: RenderedDocument | null;
  view: RenderedView;
  /** Index into `doc.changes` of the change last jumped to; -1 before the first jump. */
  change: number;
  jump: RenderedJump | null;
  selection: PdfSelection | null;
  composing: boolean;
  refresh(): Promise<void>;
  setView(view: RenderedView): void;
  /** Step to the next (1) or previous (-1) change, wrapping at either end. */
  moveChange(delta: 1 | -1): void;
  select(selection: PdfSelection | null): void;
  /** Open the composer on the current selection. False when nothing is selected. */
  compose(): boolean;
  cancel(): void;
  submit(body: string): Promise<boolean>;
  /** Open the view on a rendered thread's passage. */
  show(thread: CommentThread): void;
}

let nonce = 0;
let seq = 0;

export const useRendered = create<RenderedState>((set, get) => ({
  doc: null,
  view: 'source',
  change: -1,
  jump: null,
  selection: null,
  composing: false,

  async refresh() {
    const mine = ++seq;
    try {
      const doc = await api.document();
      if (mine !== seq) return;
      const change = doc ? Math.min(get().change, doc.changes.length - 1) : -1;
      // A review started with a document opens on it; later refreshes keep the reader's choice.
      const view = !doc ? 'source' : get().doc ? get().view : 'rendered';
      set({ doc, change, view });
    } catch (e) {
      if (mine === seq) useStore.getState().report('Loading the rendered document', e);
    }
  },

  setView(view) {
    if (view !== 'source' && !get().doc) return;
    set({ view, selection: null, composing: false });
  },

  moveChange(delta) {
    const { doc, change } = get();
    const n = doc?.changes.length ?? 0;
    if (n === 0) return useStore.getState().flash('No rendered changes');
    const next = change < 0 ? (delta > 0 ? 0 : n - 1) : (change + delta + n) % n;
    const c = doc!.changes[next]!;
    set({ change: next, jump: { old: c.old[0], new: c.new[0], nonce: ++nonce } });
    // Beside the source diff, the diff follows to the lines the change came from.
    if (get().view === 'both' && c.source)
      void useStore.getState().openFile(c.source.path, c.source.startLine, c.source.side);
  },

  select(selection) {
    set({ selection, composing: false });
  },

  compose() {
    if (!get().selection) return false;
    set({ composing: true });
    return true;
  },

  cancel() {
    set({ selection: null, composing: false });
    window.getSelection()?.removeAllRanges();
  },

  async submit(body) {
    const sel = get().selection;
    if (!sel) return false;
    try {
      await api.addThread({
        kind: 'pdf',
        side: sel.side,
        page: sel.page,
        quoted: sel.quoted,
        body,
      });
    } catch (e) {
      useStore.getState().report('Commenting', e);
      return false;
    }
    get().cancel();
    await useStore.getState().refreshThreads();
    return true;
  },

  show(thread) {
    const { doc, view } = get();
    const anchor = thread.anchor;
    if (!doc || anchor.kind !== 'pdf') return;
    set({
      view: view === 'source' ? 'rendered' : view,
      jump: { [anchor.side]: anchor.rects[0], nonce: ++nonce },
    });
  },
}));
