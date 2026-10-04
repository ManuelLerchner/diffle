import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatPrompt } from '@/server/comments/format.js';
import { UnquotableError } from '@/server/comments/CommentStore.js';
import { GitRepo } from '@/server/git/GitRepo.js';
import { findOnPath } from '@/server/lsp/which.js';
import { RenderPipeline } from '@/server/render/RenderPipeline.js';
import { TypstRenderer } from '@/server/render/typst/TypstRenderer.js';
import { Session } from '@/server/Session.js';
import type { RenderedDocument, ServerMessage } from '@/shared/protocol.js';
import { rmTmp } from '../tmp.js';

// The renderer drives the real compiler; a host without it has nothing to render.
const hasTypst = findOnPath('typst') != null;

let dir: string;
let repo: GitRepo;
let session: Session;
let doc: RenderPipeline;
const hub = {
  messages: [] as ServerMessage[],
  broadcast(m: ServerMessage) {
    this.messages.push(m);
  },
};
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();

const PAGE = '#set page(width: 12cm, height: 9cm)\n#set par(justify: true)\n#set text(font: "Libertinus Serif")\n';

const main = (intro: string) => `${PAGE}= Introduction\n${intro}\n\n#include "ch/solver.typ"\n`;
const solver = (claim: string) =>
  `= Solver\nThe #emph[solver] ${claim} for every reachable context.\nIt keeps the equations it has met in a table, and reuses their values.\n`;

const write = async (path: string, text: string) => {
  await mkdir(join(dir, path, '..'), { recursive: true });
  await writeFile(join(dir, path), text);
};

/** Each change as a reviewer reads it: what left, what came. */
const summary = (d: RenderedDocument) =>
  d.changes
    .map((c) => {
      const at = c.source ? ` (${c.source.side} ${c.source.path}:${c.source.startLine})` : '';
      return `- ${c.oldText}\n+ ${c.newText}${at}`;
    })
    .join('\n\n');

describe.skipIf(!hasTypst)('RenderPipeline with Typst', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diffle-typst-'));
    git('init', '-q', '-b', 'main');
    await write('README.md', 'not part of the document\n');
    await write('thesis/main.typ', main('This thesis studies solvers.'));
    await write('thesis/ch/solver.typ', solver('computes all equations eagerly'));
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    await write('thesis/ch/solver.typ', solver('discovers equations on demand'));
    await write('thesis/main.typ', main('This thesis studies local solvers.'));
    repo = await GitRepo.open(dir);
    session = new Session(repo, hub, { watch: false, context: 3, followRefs: 'off' });
    doc = new RenderPipeline(session, hub, 'thesis/main.typ', new TypstRenderer());
    await session.start(await session.resolve({ kind: 'working' }));
    await doc.settled();
  }, 60_000);
  afterAll(async () => {
    await session?.close();
    await rmTmp(dir);
  });

  it('renders both sides and reports only the edited words', async () => {
    const d = doc.document();
    expect(d.old?.state).toBe('ready');
    expect(d.new?.state).toBe('ready');
    await expect(summary(d)).toMatchFileSnapshot('__snapshots__/changes.txt');
    for (const c of d.changes)
      for (const r of [...c.old, ...c.new]) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.y + r.h).toBeLessThanOrEqual(1);
      }
  });

  it('typesets the removed words into a combined render and finds each change in it', () => {
    const d = doc.document();
    expect(d.combined?.state).toBe('ready');
    for (const c of d.changes) {
      expect(c.combinedAt).toBeDefined();
      // Added words are tinted where they are; removed ones are typeset, so they need no tint.
      expect(c.combined!.length > 0).toBe(c.newText !== '');
    }
  });

  it('anchors a selection on the combined render to the new words it covers', () => {
    const anchor = doc.place({
      kind: 'pdf',
      side: 'new',
      page: 1,
      combined: true,
      // Spans a removed run ("computes all") between new words.
      quoted: 'The solver computes all discovers equations',
      body: 'x',
    });
    expect(anchor).toMatchObject({ side: 'new', quoted: 'The solver discovers equations' });
  });

  it('anchors a selection to its words and traces it to the source line', async () => {
    const anchor = doc.place({
      kind: 'pdf',
      side: 'new',
      page: 1,
      // A selection may start inside a word; the anchor covers the whole word.
      quoted: 'olver discovers equations on demand',
      body: 'x',
    });
    expect(anchor.quoted).toBe('solver discovers equations on demand');
    expect(anchor.source).toEqual({ path: 'thesis/ch/solver.typ', startLine: 2, endLine: 2 });
    expect(anchor.section).toBe('Solver');
  });

  it('refuses a selection the render does not contain', () => {
    expect(() => doc.place({ kind: 'pdf', side: 'new', page: 1, quoted: 'computes all equations', body: 'x' })).toThrow(
      UnquotableError,
    );
  });

  it('exports rendered threads with their source, and relocates them after an edit', async () => {
    await session.comments.importThreads(
      [
        { kind: 'pdf', side: 'new', page: 1, quoted: 'keeps the equations it has met', body: 'Say which table.' },
        { kind: 'pdf', side: 'old', page: 1, quoted: 'computes all equations eagerly', body: 'Good riddance.' },
      ],
      { ...session.anchorSource(), placePdf: (t) => doc.place(t) },
    );
    const before = session.comments.threads().map((t) => t.anchor);
    await write('thesis/main.typ', main('This thesis studies local solvers. It adds a second sentence that reflows.'));
    await session.refresh();
    await doc.settled();
    const after = session.comments.threads();
    expect(after.every((t) => !t.stale)).toBe(true);
    expect(after.map((t) => t.anchor.kind === 'pdf' && t.anchor.quoted)).toEqual(
      before.map((a) => a.kind === 'pdf' && a.quoted),
    );
    await expect(formatPrompt(after)).toMatchFileSnapshot('__snapshots__/prompt.txt');
  });

  it('reports a compile error on its side without failing the other', async () => {
    await write('thesis/ch/solver.typ', '= Solver\n#unknown-function()\n');
    await session.refresh();
    await doc.settled();
    const d = doc.document();
    expect(d.old?.state).toBe('ready');
    expect(d.new).toMatchObject({ state: 'failed', message: expect.stringContaining('ch/solver.typ') });
    // A failed side says nothing about the passages on it.
    expect(session.comments.threads().every((t) => !t.stale)).toBe(true);
  });
});
