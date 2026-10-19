import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRepo } from '@/server/git/GitRepo.js';
import { findOnPath } from '@/server/lsp/which.js';
import { RenderPipeline } from '@/server/render/RenderPipeline.js';
import { TypstRenderer } from '@/server/render/typst/TypstRenderer.js';
import { Session } from '@/server/Session.js';
import type { RenderedDocument } from '@/shared/protocol.js';
import { rmTmp } from '../tmp.js';

const hub = { broadcast() {} };
const PAGE = '#set page(width: 10cm, height: auto)\n';

describe.skipIf(findOnPath('typst') == null)('inline removals', () => {
  let dir: string;
  let session: Session;
  let d: RenderedDocument;
  let doc: RenderPipeline;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diffle-inline-'));
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
    const write = (path: string, text: string) => writeFile(join(dir, path), text);
    git('init', '-q', '-b', 'main');
    await write('main.typ', `${PAGE}The solver computes all equations.\n\n#include "count.typ"\n`);
    await write('count.typ', '#let n = 3\nThere are #n solvers.\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    await write('main.typ', `${PAGE}The solver discovers equations.\n\n#include "count.typ"\n`);
    // The removed "3" would land in code, where Typst refuses markup.
    await write('count.typ', '#let n = 4\nThere are #n solvers.\n');
    session = new Session(await GitRepo.open(dir), hub, { watch: false, context: 3, followRefs: 'off' });
    doc = new RenderPipeline(session, hub, 'main.typ', new TypstRenderer());
    await session.start(await session.resolve({ kind: 'working' }));
    await doc.settled();
    d = doc.document();
  }, 60_000);
  afterAll(async () => {
    await doc?.close();
    await session?.close();
    await rmTmp(dir);
  });

  it('typesets removals where Typst accepts them and says which it could not', () => {
    expect(d.combined?.state).toBe('ready');
    expect(d.changes.map((c) => [c.oldText, c.newText, c.inlined])).toEqual([
      ['computes all', 'discovers', true],
      ['3', '4', false],
    ]);
  });
});
