import { mkdtemp, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOnPath } from '@/server/lsp/which.js';
import { diffKeys } from '@/server/render/diff.js';
import { extractText, type PdfText } from '@/server/render/text.js';
import { compileTypst } from '@/server/render/typst/compile.js';
import { rmTmp } from '../tmp.js';

const PROSE =
  'Interprocedural analyses of concurrent programs demand considerable engineering. ' +
  'Verification of incremental solvers requires characterizations of termination.';

describe.skipIf(findOnPath('typst') == null)('extractText', () => {
  let dir: string;
  let text: PdfText;
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'diffle-text-')));
    // A narrow justified column forces hyphenation.
    await writeFile(
      join(dir, 'main.typ'),
      `#set page(width: 5cm, height: auto, margin: 0.5cm)\n#set par(justify: true)\n#set text(lang: "en")\n= Heading\n${PROSE}\n`,
    );
    const compiled = await compileTypst(dir, 'main.typ');
    if (!compiled.ok) throw new Error(compiled.message);
    text = await extractText(compiled.pdf);
  }, 30_000);
  afterAll(() => rmTmp(dir));

  it('joins words the typesetter hyphenated across lines', () => {
    expect(text.words.map((w) => w.text).join(' ')).toBe(`Heading ${PROSE}`);
    // The hyphenation happened: some word spans two lines.
    expect(text.words.some((w) => w.rects.length === 2)).toBe(true);
  });

  it('reads reflowed text as the same words, compounds included', async () => {
    const compounds =
      `${PROSE} Context-sensitive, flow-insensitive and path-sensitive over-approximations ` +
      'of well-known state-of-the-art analyzers.';
    const render = async (width: string) => {
      await writeFile(
        join(dir, 'reflow.typ'),
        `#set page(width: ${width}, height: auto, margin: 0.5cm)\n#set par(justify: true)\n#set text(lang: "en")\n${compounds}\n`,
      );
      const compiled = await compileTypst(dir, 'reflow.typ');
      if (!compiled.ok) throw new Error(compiled.message);
      return (await extractText(compiled.pdf)).words;
    };
    const [narrow, wide] = [await render('4.2cm'), await render('6.5cm')];
    // Different breaks, different hyphenation: still no word differs.
    expect(narrow.length).not.toBe(0);
    expect(
      diffKeys(
        narrow.map((w) => w.key),
        wide.map((w) => w.key),
      ),
    ).toEqual([]);
  });

  it('places every box inside its page', () => {
    for (const r of text.words.flatMap((w) => w.rects)) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1);
    }
  });

  it('tells the document it is a review render', async () => {
    await writeFile(join(dir, 'probe.typ'), '#sys.inputs.at("diffle", default: "absent")\n');
    const compiled = await compileTypst(dir, 'probe.typ');
    if (!compiled.ok) throw new Error(compiled.message);
    expect((await extractText(compiled.pdf)).words.map((w) => w.text)).toEqual(['1']);
  });

  it('resolves the outline to the heading word', () => {
    expect(text.headings).toEqual([{ title: 'Heading', word: 0 }]);
  });
});
