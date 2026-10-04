import { describe, expect, it } from 'vitest';
import { findPassage, selectionKeys, sourceOf, spanRects } from '@/server/render/passage.js';
import { typstProse } from '@/server/render/typst/prose.js';
import { type PdfWord, wordKey } from '@/server/render/text.js';

const words = (text: string, page = 1): PdfWord[] =>
  text.split(' ').map((t, i) => ({
    text: t,
    key: wordKey(t),
    page,
    rects: [{ page, x: i * 0.1, y: 0.5, w: 0.08, h: 0.02 }],
  }));

describe('selectionKeys', () => {
  it('drops a typesetter hyphen before a line break and folds math letters', () => {
    expect(selectionKeys('static analy-\nsis of 𝑥')).toEqual(['static', 'analysis', 'of', 'x']);
  });
});

describe('findPassage', () => {
  const doc = words('the solver computes the solver result');

  it('widens a selection that starts or ends inside a word to whole words', () => {
    expect(findPassage(doc, selectionKeys('olver comp'), 0)).toEqual({ start: 1, end: 3 });
  });

  it('prefers the occurrence nearest the hint', () => {
    expect(findPassage(doc, ['the', 'solver'], 0)).toEqual({ start: 0, end: 2 });
    expect(findPassage(doc, ['the', 'solver'], 4)).toEqual({ start: 3, end: 5 });
  });

  it('finds nothing for text the render lacks', () => {
    expect(findPassage(doc, ['solver', 'stores'], 0)).toBeNull();
  });
});

describe('spanRects', () => {
  it('merges the words of one line into one box', () => {
    const [box, ...rest] = spanRects(words('a b c'), { start: 0, end: 3 });
    expect(rest).toEqual([]);
    expect(box).toMatchObject({ page: 1, x: 0, y: 0.5 });
    expect(box!.w).toBeCloseTo(0.28);
    expect(box!.h).toBeCloseTo(0.02);
  });
});

describe('sourceOf', () => {
  const sources = new Map([
    [
      'ch/solver.typ',
      typstProse(
        [
          '= The Solver',
          '// The solver computes everything. (a comment, never rendered)',
          'The #emph[verified] solver computes $x <= y$',
          'for every reachable context, see @fig:solver.',
          '#figure(rect(), caption: [The solver]) <fig:solver>',
        ].join('\n'),
      ),
    ],
    ['ch/intro.typ', typstProse('A solver is a program.\nThe solver runs.\n')],
  ]);

  it('traces a passage through markup, math and a line break to its lines', () => {
    expect(sourceOf('verified solver computes 𝑥 ≤ 𝑦 for every reachable context', sources)).toEqual({
      path: 'ch/solver.typ',
      startLine: 3,
      endLine: 4,
    });
  });

  it('gives up on a passage that occurs in more than one place', () => {
    expect(sourceOf('The solver', sources)).toBeNull();
  });

  it('gives up on a single word', () => {
    expect(sourceOf('program', sources)).toBeNull();
  });
});
