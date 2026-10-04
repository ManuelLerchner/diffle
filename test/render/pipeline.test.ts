import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRepo } from '@/server/git/GitRepo.js';
import { RenderPipeline } from '@/server/render/RenderPipeline.js';
import { Session } from '@/server/Session.js';
import { rmTmp } from '../tmp.js';
import { TextRenderer } from './textRenderer.js';

const hub = { broadcast() {} };

// The pipeline knows no format: a plain-text renderer runs it end to end, with no compiler installed.
describe('RenderPipeline with any renderer', () => {
  let dir: string;
  let session: Session;
  let doc: RenderPipeline;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diffle-pipeline-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      });
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
