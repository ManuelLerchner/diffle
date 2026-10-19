import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOnPath } from '@/server/lsp/which.js';
import type { Compiled } from '@/server/render/Renderer.js';
import { extractText } from '@/server/render/text.js';
import { TypstWatch } from '@/server/render/typst/watch.js';
import { Workspace } from '@/server/render/Workspace.js';

const page = '#set page(width: 300pt, height: auto, margin: 20pt)\n';
const files = (body: string, extra: Record<string, string> = {}) =>
  new Map(
    Object.entries({ 'main.typ': `${page}#include "ch.typ"\n`, 'ch.typ': body, ...extra }).map(([k, v]) => [
      k,
      Buffer.from(v),
    ]),
  );

async function words(c: Compiled): Promise<string> {
  if (!c.ok) return `failed: ${c.message}`;
  return (await extractText(c.pdf)).words.map((w) => w.text).join(' ');
}

describe.skipIf(findOnPath('typst') == null)('TypstWatch', () => {
  let ws: Workspace;
  let watch: TypstWatch;
  const compile = (set: Map<string, Buffer>) => watch.compile(() => ws.sync(set));

  beforeAll(async () => {
    ws = await Workspace.create();
    watch = new TypstWatch('typst', ws.root, 'main.typ');
  });
  afterAll(async () => {
    watch.stop();
    await ws.remove();
  });

  it('recompiles an edit in the running watcher', async () => {
    const first = await compile(files('The solver computes.'));
    expect(await words(first)).toBe('The solver computes.');
    expect(first.ok && first.inputs.sort()).toEqual(['ch.typ', 'main.typ']);
    expect(await words(await compile(files('The solver discovers.')))).toBe('The solver discovers.');
  }, 30_000);

  it('reports a broken edit by its file, and recovers', async () => {
    const broken = await compile(files('#(1 + "a")'));
    expect(broken).toMatchObject({ ok: false, file: 'ch.typ' });
    expect(!broken.ok && broken.message).toContain('cannot add');
    expect(await words(await compile(files('Fixed.')))).toBe('Fixed.');
  }, 30_000);

  // The watcher never recompiles for a file the document does not read, so waiting would stall.
  it('answers an edit outside the document with the last render', async () => {
    const last = await compile(files('Fixed.', { 'notes.md': 'one' }));
    const started = Date.now();
    expect(await compile(files('Fixed.', { 'notes.md': 'two' }))).toBe(last);
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 30_000);

  it('fails rather than compiles cold once stopped', async () => {
    watch.stop();
    expect(await compile(files('After.'))).toEqual({ ok: false, message: 'rendering stopped' });
  });
});
