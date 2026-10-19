import { proseWords } from '@/server/render/passage.js';
import type { SourceToken } from '@/server/render/Renderer.js';

/**
 * The prose words of a Typst file with their lines. Comments go, and so do identifiers called with `#`,
 * references and labels: they name markup, not text a reader sees.
 */
export function typstProse(contents: string): SourceToken[] {
  const out: SourceToken[] = [];
  const blanked = contents.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  for (const [i, raw] of blanked.split('\n').entries()) {
    const line = raw
      .replace(/(^|[^:])\/\/.*$/, '$1')
      .replace(/[#@][\p{L}_][\p{L}\p{N}_.-]*|<[\p{L}\p{N}_:.-]+>/gu, ' ');
    for (const token of proseWords(line)) out.push({ token, line: i + 1 });
  }
  return out;
}
