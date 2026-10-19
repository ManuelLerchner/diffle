import { copyFile, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOnPath } from '@/server/lsp/which.js';
import { compileTypst } from '@/server/render/typst/compile.js';
import { rmTmp } from '../tmp.js';

const hasTypst = findOnPath('typst') != null;
const font = join(
  dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
  'standard_fonts/LiberationSans-Regular.ttf',
);

describe.skipIf(!hasTypst)('compileTypst', () => {
  let root: string;
  const ignored = process.env.TYPST_IGNORE_SYSTEM_FONTS;

  beforeAll(async () => {
    // Only a font the tree ships can satisfy the document.
    process.env.TYPST_IGNORE_SYSTEM_FONTS = 'true';
    root = await realpath(await mkdtemp(join(tmpdir(), 'diffle-compile-')));
    await mkdir(join(root, 'assets/fonts'), { recursive: true });
    await copyFile(font, join(root, 'assets/fonts/LiberationSans-Regular.ttf'));
    await writeFile(join(root, 'main.typ'), '#set text(font: "Liberation Sans", fallback: false)\nHello.\n');
  });
  afterAll(async () => {
    if (ignored === undefined) delete process.env.TYPST_IGNORE_SYSTEM_FONTS;
    else process.env.TYPST_IGNORE_SYSTEM_FONTS = ignored;
    await rmTmp(root);
  });

  it('typesets with the fonts the tree ships', async () => {
    const compiled = await compileTypst(root, 'main.typ');
    const pdf = compiled.ok ? compiled.pdf.toString('latin1') : compiled.message;
    expect(pdf).toContain('LiberationSans');
  });
});
