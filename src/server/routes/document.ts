import type { Hono } from 'hono';
import { DocumentPdfQuerySchema } from '@/shared/protocol.js';
import type { ApiDeps } from './api.js';

/** The `--typst` document's render state and the PDFs of its current sides. */
export function documentRoutes(app: Hono, deps: ApiDeps): void {
  app.get('/api/document', (c) => {
    if (!deps.document) return c.json({ error: 'this review renders no document (start diffle with --typst)' }, 404);
    return c.json(deps.document.document());
  });

  // Served only while its key names a current side, so a key never names other bytes.
  app.get('/api/document/pdf', (c) => {
    const { rev, key } = DocumentPdfQuerySchema.parse(c.req.query());
    const pdf = deps.document?.pdf(rev, key);
    if (!pdf) return c.json({ error: 'no render under that key' }, 404);
    return c.body(new Uint8Array(pdf), 200, {
      'content-type': 'application/pdf',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    });
  });
}
