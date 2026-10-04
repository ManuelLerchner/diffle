import { create } from 'zustand';
import type { PdfRect, RenderedDocument } from '@/shared/protocol.js';
import { api } from '@/client/api.js';
import { useStore } from '@/client/store.js';

/** Where the pages scroll next: each side's rect lands at the gaze point; a new nonce lands it again. */
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
  refresh(): Promise<void>;
  setView(view: RenderedView): void;
  /** Step to the next (1) or previous (-1) change, wrapping at either end. */
  moveChange(delta: 1 | -1): void;
}

let nonce = 0;
let seq = 0;

export const useRendered = create<RenderedState>((set, get) => ({
  doc: null,
  view: 'source',
  change: -1,
  jump: null,

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
    set({ view });
  },

  moveChange(delta) {
    const { doc, change } = get();
    const n = doc?.changes.length ?? 0;
    if (n === 0) return useStore.getState().flash('No rendered changes');
    const next = change < 0 ? (delta > 0 ? 0 : n - 1) : (change + delta + n) % n;
    const c = doc!.changes[next]!;
    set({ change: next, jump: { old: c.old[0], new: c.new[0], nonce: ++nonce } });
  },
}));
