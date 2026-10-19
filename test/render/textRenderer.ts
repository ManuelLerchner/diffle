import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { proseWords } from '@/server/render/passage.js';
import type { Compiled, Renderer, SourceToken } from '@/server/render/Renderer.js';

/**
 * A renderer for plain text, for tests that must not depend on an installed compiler: each line of
 * the entry becomes a line of Helvetica on one PDF page, written by hand.
 */
export class TextRenderer implements Renderer {
  async version(): Promise<string> {
    return 'text 1';
  }

  async compile(root: string, entry: string): Promise<Compiled> {
    let source: string;
    try {
      source = await readFile(join(root, entry), 'utf8');
    } catch {
      return { ok: false, message: `${entry}: file not found` };
    }
    return { ok: true, pdf: textPdf(source.split('\n')), inputs: [entry] };
  }

  proseTokens(path: string, contents: string): SourceToken[] | null {
    if (!path.endsWith('.txt')) return null;
    return contents.split('\n').flatMap((line, i) => proseWords(line).map((token) => ({ token, line: i + 1 })));
  }
}

/** A one-page PDF showing `lines` top to bottom, 12pt Helvetica, 16pt apart. */
function textPdf(lines: string[]): Buffer {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const body = lines.map((l, i) => `BT /F1 12 Tf 50 ${750 - i * 16} Td (${escape(l)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
