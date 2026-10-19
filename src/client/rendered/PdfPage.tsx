import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/client/api.js';
import type { Surface } from '@/shared/protocol.js';

type PdfLib = typeof import('pdfjs-dist');

let lib: Promise<PdfLib> | null = null;

/** pdf.js loads on first use: a review without a rendered document never downloads it. */
function pdfjs(): Promise<PdfLib> {
  lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([mod, worker]) => {
      mod.GlobalWorkerOptions.workerSrc = worker.default;
      return mod;
    },
  );
  return lib;
}

/** Open documents by URL. A key names fixed bytes, so an entry never goes stale; the oldest are closed. */
const docs = new Map<string, Promise<PDFDocumentLoadingTask>>();
const KEEP_DOCS = 4;

export function loadPdf(surface: Surface, key: string): Promise<PDFDocumentProxy> {
  const url = api.documentPdfUrl(surface, key);
  let task = docs.get(url);
  if (!task) {
    task = pdfjs().then((p) => p.getDocument({ url }));
    docs.set(url, task);
    while (docs.size > KEEP_DOCS) {
      const [oldest, evicted] = docs.entries().next().value!;
      docs.delete(oldest);
      void evicted.then((t) => t.destroy()).catch(() => {});
    }
  }
  const doc = task.then((t) => t.promise);
  doc.catch(() => docs.get(url) === task && docs.delete(url));
  return doc;
}

/**
 * One page at `scale` CSS pixels per point: a canvas for the ink and pdf.js's text layer for
 * selection, both drawn only while the page is near the viewport, since a document's pages at
 * device resolution would not fit in memory at once. `children` overlay the page in its own box, above the
 * text layer: they must not take pointer events except where a click means something.
 */
export const PdfPage = memo(function PdfPage({
  doc,
  page,
  width,
  height,
  scale,
  root,
  children,
}: {
  doc: PDFDocumentProxy | null;
  page: number;
  /** CSS pixels. */
  width: number;
  height: number;
  scale: number;
  /** The scrolling column, which decides what is near the viewport. */
  root: HTMLElement | null;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting ?? false), {
      root,
      rootMargin: '150% 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const c = canvas.current;
    const layer = text.current;
    if (!c || !layer) return;
    const clear = () => {
      c.width = 0;
      c.height = 0;
      layer.replaceChildren();
    };
    if (!doc || !near) return clear;
    let live = true;
    let task: RenderTask | null = null;
    void (async () => {
      const [p, lib] = await Promise.all([doc.getPage(page), pdfjs()]);
      if (!live) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: scale * dpr });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      task = p.render({ canvas: c, viewport });
      layer.replaceChildren();
      layer.style.setProperty('--total-scale-factor', String(scale));
      const textLayer = new lib.TextLayer({
        textContentSource: p.streamTextContent(),
        container: layer,
        viewport: p.getViewport({ scale }),
      });
      await Promise.all([task.promise, textLayer.render()]);
    })().catch((e: unknown) => {
      // A render cancelled by scrolling away or a new scale is expected.
      if ((e as Error).name !== 'RenderingCancelledException') console.error('[diffle] page render failed:', e);
    });
    return () => {
      live = false;
      task?.cancel();
      clear();
    };
  }, [doc, page, scale, near]);

  return (
    <div ref={box} data-page={page} className="relative mx-auto bg-white shadow-card" style={{ width, height }}>
      <canvas ref={canvas} className="absolute inset-0 size-full" />
      <div ref={text} className="textLayer" />
      {/* Above the text layer, so its markers take clicks; the tints let selection through. */}
      {children}
    </div>
  );
});
