import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRepo } from '@/server/git/GitRepo.js';
import { RenderPipeline } from '@/server/render/RenderPipeline.js';
import { Session } from '@/server/Session.js';
import { rmTmp } from '../tmp.js';
import { TextRenderer } from './textRenderer.js';

const hub = { broadcast() {} };
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

// The pipeline knows no format: a plain-text renderer runs it end to end, with no compiler installed.
describe('RenderPipeline with any renderer', () => {
  let dir: string;
  let session: Session;
  let doc: RenderPipeline;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diffle-pipeline-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env });
    git('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'doc.txt'), 'The solver computes all equations.\nIt keeps a table.\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    await writeFile(join(dir, 'doc.txt'), 'The solver discovers equations.\nIt keeps a table.\n');
    session = new Session(await GitRepo.open(dir), hub, { watch: false, context: 3, followRefs: 'off' });
    doc = new RenderPipeline(session, hub, 'doc.txt', new TextRenderer());
    await session.start(await session.resolve({ kind: 'working' }));
    await doc.settled();
  }, 30_000);
  afterAll(async () => {
    await session?.close();
    await rmTmp(dir);
  });

  it('compiles both sides and reports the changed words, traced to their source line', () => {
    const d = doc.document();
    expect([d.old?.state, d.new?.state]).toEqual(['ready', 'ready']);
    // No `inline`: the renderer cannot typeset removals, so there is no combined render.
    expect(d.combined).toBeNull();
    expect(d.changes.map((c) => [c.oldText, c.newText, c.source && `${c.source.path}:${c.source.startLine}`])).toEqual([
      ['computes all', 'discovers', 'doc.txt:1'],
    ]);
  });

  it('anchors a selection and traces it to its line', () => {
    expect(doc.place({ kind: 'pdf', side: 'new', page: 1, quoted: 'It keeps a table.', body: 'x' })).toMatchObject({
      quoted: 'It keeps a table.',
      source: { path: 'doc.txt', startLine: 2, endLine: 2 },
    });
  });
});

const FILES = ['doc.txt', 'a.txt', 'b.txt'];

/**
 * Appends each file's removed text to it, as `[-…-]`. Markers in `b.txt` break the document with an
 * error located in a file no insertion touched, as a template tripping over an unmade heading does.
 */
class InliningRenderer extends TextRenderer {
  /** Per compile with insertions, the files that carried them. */
  readonly trials: string[][] = [];

  inline(_path: string, oldSource: string, newSource: string): string {
    return `${newSource}[-${oldSource.trim()}-]\n`;
  }

  override async compile(root: string, entry: string) {
    const marked: string[] = [];
    for (const f of FILES) if ((await readFile(join(root, f), 'utf8')).includes('[-')) marked.push(f);
    if (marked.length) this.trials.push(marked);
    if (marked.includes('b.txt')) return { ok: false as const, message: 'template.txt:1: no heading' };
    return super.compile(root, entry);
  }
}

describe('RenderPipeline combining removals', () => {
  let dir: string;
  let session: Session;
  let doc: RenderPipeline;
  const renderer = new InliningRenderer();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diffle-combine-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env });
    git('init', '-q', '-b', 'main');
    for (const f of FILES) await writeFile(join(dir, f), `Old ${f}.\n`);
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    for (const f of FILES) await writeFile(join(dir, f), `New ${f}.\n`);
    session = new Session(await GitRepo.open(dir), hub, { watch: false, context: 3, followRefs: 'off' });
    doc = new RenderPipeline(session, hub, 'doc.txt', renderer);
    await session.start(await session.resolve({ kind: 'working' }));
    await doc.settled();
  }, 30_000);
  afterAll(async () => {
    await session?.close();
    await rmTmp(dir);
  });

  it('drops the insertions that break the document though the error names another file', () => {
    expect(doc.document().combined?.state).toBe('ready');
    // Halves of the tree-ordered files: [a, b] fails; [a] passes; [a, b] again is cached; [doc] passes.
    expect(renderer.trials).toEqual([
      ['doc.txt', 'a.txt', 'b.txt'],
      ['a.txt', 'b.txt'],
      ['a.txt'],
      ['doc.txt', 'a.txt'],
    ]);
  });
});
