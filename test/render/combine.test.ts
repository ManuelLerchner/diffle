import { describe, expect, it } from 'vitest';
import { combineSource, readable, removedMarkup } from '@/server/render/typst/combine.js';

describe('combineSource', () => {
  it('leaves an unchanged file alone', () => {
    expect(combineSource('= A\nText.\n', '= A\nText.\n')).toBe('= A\nText.\n');
  });

  it('puts removed words back before the words that replaced them', async () => {
    const old = [
      '= The Solver',
      'The #emph[solver] computes all equations eagerly',
      'and stores every intermediate value.',
      '',
      'This paragraph goes away entirely.',
      '',
      'The end.',
    ].join('\n');
    const next = [
      '= The Solver',
      'The #emph[solver] discovers equations on demand',
      'and stores only the values it needs.',
      '',
      'The end. A new sentence.',
    ].join('\n');
    await expect(combineSource(old, next)).toMatchFileSnapshot('__snapshots__/combined.typ');
  });

  it('appends words removed from the end', () => {
    expect(combineSource('One two three.', 'One two')).toBe(`One two ${removedMarkup('three.')}`);
  });
});

describe('readable', () => {
  it('keeps the words of removed markup, not its syntax', () => {
    expect(readable('the #emph[verified] solver, see @fig:solver <lbl> // note\n*bold* $x$')).toBe(
      'the verified solver, see fig:solver bold x',
    );
  });
});

describe('removedMarkup', () => {
  it('escapes the words as a Typst string', () => {
    expect(removedMarkup('a "quoted" \\ word')).toContain('"a \\"quoted\\" \\\\ word"');
  });
});
