import type { PdfRect } from '@/shared/protocol.js';
import type { PdfWord } from './text.js';

/** A run of words: `[start, end)` into a side's word list. */
export interface Span {
  start: number;
  end: number;
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
