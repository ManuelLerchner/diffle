import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ChevronDown, ChevronUp, FileText, LoaderCircle, MessageSquare, MessageSquarePlus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CommentThread, PdfRect, RenderedDocument, Side } from '@/shared/protocol.js';
import { pdfLabel, visibleThreads } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { loadPdf, PdfPage } from './PdfPage.js';
import { useRendered } from './state.js';

/** Where a jump parks its target, as a fraction of the column's height; the diff's gaze point. */
const EYE_FRACTION = 0.5;
/** Space around and between pages, in CSS pixels. */
const GAP = 16;
/** Widest a page is drawn, in CSS pixels: one column on a wide screen would set the text at poster size. */
const MAX_PAGE_WIDTH = 900;

/**
 * The `--typst` document as the new side renders it, with the words an edit brought tinted green and the
 * words it took away marked in the margin: one column, read like the document itself. When the new side
 * does not compile, the old one stands in under the compiler's message. It covers the diff, or sits
 * beside it; the diff stays mounted either way and keeps its place.
 */
export function RenderedPane() {
  const doc = useRendered((s) => s.doc);
  const view = useRendered((s) => s.view);
  if (!doc || view === 'source') return null;
  const shown: Side = doc.new?.state === 'ready' || doc.old?.state !== 'ready' ? 'new' : 'old';
  return (
    <section
      className={`flex min-h-0 flex-col bg-canvas ${view === 'rendered' ? 'absolute inset-0 z-10' : 'border-l border-l-border'}`}
      aria-label={`Rendered ${doc.entry}`}
      data-rendered
    >
      <Toolbar doc={doc} side={shown} />
      {shown === 'old' && doc.new?.state === 'failed' && (
        <div className="border-b border-b-border bg-surface px-3 py-1.5 text-[0.75rem]">
          <span className="font-semibold text-danger">The new side does not compile; showing the old one.</span>
          <pre className="m-0 mt-1 max-h-24 overflow-auto font-mono whitespace-pre-wrap">{doc.new.message}</pre>
        </div>
      )}
      <Column doc={doc} side={shown} />
      <SelectionActions />
    </section>
  );
}

function Toolbar({ doc, side }: { doc: RenderedDocument; side: Side }) {
  const rendered = doc[side];
  const change = useRendered((s) => s.change);
  const moveChange = useRendered((s) => s.moveChange);
  const setView = useRendered((s) => s.setView);
  const n = doc.changes.length;
  return (
    <div className="flex items-center gap-2 border-b border-b-border bg-surface px-3 py-1 text-[0.8125rem]">
      <FileText size="0.875rem" className="text-accent" />
      <span className="font-mono text-[0.75rem] font-semibold">{doc.entry}</span>
      {rendered?.state === 'ready' && (
        <span className="text-[0.75rem] text-muted">
          {rendered.pages.length} page{rendered.pages.length === 1 ? '' : 's'}
        </span>
      )}
      {doc.rendering && (
        <span className="inline-flex items-center gap-1 text-muted">
          <LoaderCircle size="0.75rem" className="animate-spin" /> rendering
        </span>
      )}
      <span className="flex-1" />
      <span className="text-muted">
        {n === 0 ? 'no text changes' : `${change < 0 ? '–' : change + 1} / ${n} change${n === 1 ? '' : 's'}`}
      </span>
      <Button variant="ghost" icon disabled={n === 0} onClick={() => moveChange(-1)} title="Previous change (k)">
        <ChevronUp size="0.875rem" />
      </Button>
      <Button variant="ghost" icon disabled={n === 0} onClick={() => moveChange(1)} title="Next change (j)">
        <ChevronDown size="0.875rem" />
      </Button>
      <Button variant="ghost" icon onClick={() => setView('source')} title="Back to the source diff (p)">
        <X size="0.875rem" />
      </Button>
    </div>
  );
}

/** Tints on the page, which is paper whatever the theme: the diff's hues at a strength that keeps ink readable. */
const TINT: Record<Side, string> = { old: 'rgb(255 80 80 / 0.28)', new: 'rgb(40 180 70 / 0.28)' };
const CARET: Record<Side, string> = { old: 'rgb(200 30 30)', new: 'rgb(20 130 50)' };
const THREAD_TINT = 'rgb(255 200 0 / 0.35)';

interface Placed {
  rect: PdfRect;
  /** Index into the document's changes, or the thread the rect belongs to. */
  change?: number;
  thread?: CommentThread;
  /** Words that left at this change, marked in the margin beside this rect. */
  removed?: string;
}

function Column({ doc, side }: { doc: RenderedDocument; side: Side }) {
  const rendered = doc[side];
  const scroller = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const jump = useRendered((s) => s.jump);
  const current = useRendered((s) => s.change);
  const select = useRendered((s) => s.select);
  const composing = useRendered((s) => s.composing);
  const allThreads = useStore((s) => s.threads);
  const showResolved = useStore((s) => s.showResolved);
  const threads = useMemo(() => visibleThreads({ threads: allThreads, showResolved }), [allThreads, showResolved]);
  const focusThread = useStore((s) => s.focusThread);
  const focused = useStore((s) => s.focusedThread);

  const key = rendered?.state === 'ready' ? rendered.key : null;
  useEffect(() => {
    if (!key) return setPdf(null);
    let live = true;
    loadPdf(side, key).then(
      (d) => live && setPdf(d),
      (e: unknown) => live && useStore.getState().report('Loading the PDF', e),
    );
    return () => {
      live = false;
    };
  }, [side, key]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setRoot(el);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pages = rendered?.state === 'ready' ? rendered.pages : null;
  // Every page fits the column's width; the sizes come with the document, so layout needs no PDF.
  const layout = useMemo(() => pageLayout(pages ?? [], width), [pages, width]);

  const byPage = useMemo(() => {
    const out = new Map<number, Placed[]>();
    const add = (p: Placed) => {
      const list = out.get(p.rect.page) ?? [];
      list.push(p);
      out.set(p.rect.page, list);
    };
    doc.changes.forEach((c, i) =>
      c[side].forEach((rect, j) =>
        add({ rect, change: i, ...(side === 'new' && j === 0 && c.oldText ? { removed: c.oldText } : {}) }),
      ),
    );
    for (const t of threads)
      if (t.anchor.kind === 'pdf' && t.anchor.side === side && !t.stale)
        t.anchor.rects.forEach((rect) => add({ rect, thread: t }));
    return out;
  }, [doc.changes, threads, side]);

  // A jump lands its rect at the gaze point; positions come from the layout, not from measuring the DOM.
  useLayoutEffect(() => {
    const rect = jump?.[side];
    const el = scroller.current;
    const box = rect && layout[rect.page - 1];
    if (!el || !box) return;
    el.scrollTo({ top: box.top + rect.y * box.height - el.clientHeight * EYE_FRACTION });
  }, [jump, side, layout]);

  const onMouseUp = () => {
    const sel = window.getSelection();
    const el = scroller.current;
    if (!sel || sel.isCollapsed || !el || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    const quoted = sel.toString();
    const start = range.startContainer;
    const pageEl = (start instanceof Element ? start : start.parentElement)?.closest<HTMLElement>('[data-page]');
    if (!quoted.trim() || !pageEl) return;
    const end = range.getClientRects();
    const last = end[end.length - 1] ?? range.getBoundingClientRect();
    select({ side, page: Number(pageEl.dataset.page), quoted, at: { x: last.right, y: last.bottom } });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto bg-hover"
        onMouseUp={onMouseUp}
        onScroll={() => !composing && useRendered.getState().selection && select(null)}
      >
        {rendered == null ? (
          <Notice>Rendering…</Notice>
        ) : rendered.state === 'absent' ? (
          <Notice>
            No <code>{doc.entry}</code> on this side
          </Notice>
        ) : rendered.state === 'failed' ? (
          <div className="m-3 rounded-md border border-danger bg-canvas p-3">
            <div className="mb-1.5 text-[0.8125rem] font-semibold text-danger">Typst could not compile this side</div>
            <pre className="m-0 font-mono text-[0.75rem] leading-[1.5] whitespace-pre-wrap text-foreground">
              {rendered.message}
            </pre>
          </div>
        ) : (
          <div style={{ paddingBlock: GAP }} className="flex flex-col" data-side={side}>
            {layout.map((box, i) => (
              <div key={i} style={{ marginBottom: i === layout.length - 1 ? 0 : GAP }}>
                <PdfPage doc={pdf} page={i + 1} width={box.width} height={box.height} scale={box.scale} root={root}>
                  {(byPage.get(i + 1) ?? []).map((p, j) => (
                    <Mark
                      key={j}
                      placed={p}
                      side={side}
                      current={p.change != null && p.change === current}
                      focused={p.thread != null && p.thread.id === focused}
                      onThread={(t) => focusThread(t.id)}
                    />
                  ))}
                </PdfPage>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface PageBox {
  /** Offset from the top of the scrolled content, in CSS pixels. */
  top: number;
  width: number;
  height: number;
  /** CSS pixels per PDF point. */
  scale: number;
}

function pageLayout(pages: readonly { width: number; height: number }[], width: number): PageBox[] {
  const out: PageBox[] = [];
  for (const p of pages) {
    const prev = out[out.length - 1];
    const scale = Math.max(1, Math.min(width - 2 * GAP, MAX_PAGE_WIDTH)) / p.width;
    out.push({
      top: prev ? prev.top + prev.height + GAP : GAP,
      width: p.width * scale,
      height: p.height * scale,
      scale,
    });
  }
  return out;
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="p-10 text-center text-[0.8125rem] text-muted">{children}</div>;
}

const pct = (n: number) => `${n * 100}%`;

/** A change tint, a caret where one side has no words, or a thread's passage with a pin in the margin. */
function Mark({
  placed: { rect, change, thread, removed },
  side,
  current,
  focused,
  onThread,
}: {
  placed: Placed;
  side: Side;
  current: boolean;
  focused: boolean;
  onThread: (t: CommentThread) => void;
}) {
  const style = { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) };
  if (change != null)
    return (
      <>
        {removed != null && <RemovedMarker rect={rect} text={removed} current={current} />}
        <div
          data-change={change}
          className="pointer-events-none absolute mix-blend-multiply"
          style={{
            ...style,
            ...(rect.w === 0
              ? // A caret marks where the other side's words were: on the new side, a deletion.
                { width: 2, marginLeft: -1, background: CARET[side === 'new' ? 'old' : 'new'] }
              : { background: TINT[side], borderRadius: 2 }),
            outline: current ? `2px solid ${CARET[side]}` : undefined,
            outlineOffset: 1,
          }}
        />
      </>
    );
  if (!thread) return removed != null ? <RemovedMarker rect={rect} text={removed} current={false} /> : null;
  const t = thread;
  return (
    <>
      <div
        className="pointer-events-none absolute mix-blend-multiply"
        style={{
          ...style,
          background: THREAD_TINT,
          boxShadow: focused ? '0 0 0 2px var(--accent)' : undefined,
        }}
      />
      <button
        type="button"
        className="absolute right-1 flex cursor-pointer items-center rounded-sm border border-border bg-card p-0.5 text-accent shadow-card"
        style={{ top: pct(rect.y) }}
        title={t.messages[0]?.body}
        aria-label="Show comment"
        onClick={() => onThread(t)}
      >
        <MessageSquare size="0.75rem" />
      </button>
    </>
  );
}

/**
 * In the left margin beside a change: a red bar saying words left here, which shows them on click.
 * Removed text has no place in the new layout, so it is told rather than drawn.
 */
function RemovedMarker({ rect, text, current }: { rect: PdfRect; text: string; current: boolean }) {
  const [open, setOpen] = useState(false);
  const words = text.split(' ').length;
  return (
    <div className={`absolute left-1 ${open ? 'z-30' : 'z-10'}`} style={{ top: pct(rect.y) }}>
      <button
        type="button"
        className={`flex cursor-pointer items-center rounded-sm px-1 font-sans text-[0.625rem] leading-[1.4] font-semibold text-white ${current ? 'ring-2 ring-[rgb(200_30_30)]/40' : ''}`}
        style={{ background: CARET.old }}
        title={`Removed: ${text}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        −{words}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 rounded-md border border-border bg-card p-2 font-sans text-[0.75rem] leading-[1.45] text-foreground shadow-card">
          <div className="mb-1 font-semibold text-del">Removed</div>
          <div className="[text-decoration-color:rgb(200_30_30_/_0.6)] [text-decoration:line-through]">{text}</div>
        </div>
      )}
    </div>
  );
}

/** The button that turns a selection into a comment, then the composer at the same spot. */
function SelectionActions() {
  const selection = useRendered((s) => s.selection);
  const composing = useRendered((s) => s.composing);
  const compose = useRendered((s) => s.compose);
  if (!selection) return null;
  const x = Math.min(selection.at.x, window.innerWidth - (composing ? 360 : 140));
  const y = Math.min(selection.at.y + 6, window.innerHeight - (composing ? 220 : 40));
  return (
    <div className="fixed z-30" style={{ left: Math.max(8, x), top: y }}>
      {composing ? (
        <Composer />
      ) : (
        <Button
          variant="primary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => compose()}
          title="Comment on the selection (c)"
        >
          <MessageSquarePlus size="0.8125rem" /> Comment
        </Button>
      )}
    </div>
  );
}

function Composer() {
  const selection = useRendered((s) => s.selection)!;
  const submit = useRendered((s) => s.submit);
  const cancel = useRendered((s) => s.cancel);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await submit(text);
    } finally {
      setBusy(false);
    }
  };
  const preview = selection.quoted.replace(/\s+/g, ' ').trim();
  return (
    <div className="w-[22rem] overflow-hidden rounded-md border border-accent bg-surface font-sans text-[0.8125rem] shadow-card">
      <div className="flex items-center gap-2 border-b border-b-border bg-hover px-2.5 py-1 text-[0.75rem] text-muted">
        <MessageSquare size="0.8125rem" className="flex-none text-accent" />
        <span className="font-mono font-semibold text-foreground">{pdfLabel(selection)}</span>
        <span className="truncate" title={preview}>
          {preview}
        </span>
      </div>
      <div className="p-2">
        <textarea
          autoFocus
          className="min-h-17.5 w-full resize-y rounded-sm border border-border bg-canvas p-1.5 font-mono text-[0.75rem] leading-[1.5]"
          value={text}
          placeholder="Leave a comment…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          }}
        />
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <span className="mr-auto text-[0.75rem] text-muted">
            <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> to save
          </span>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={!text.trim() || busy}>
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}
