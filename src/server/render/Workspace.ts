import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A temporary directory that holds one file set at a time and moves to the next by writing only the
 * files that differ, so a compiler watching it sees an edit as an edit. Files it did not write, such
 * as a compiler's own output, are left alone.
 */
export class Workspace {
  private files = new Map<string, Buffer>();

  private constructor(readonly root: string) {}

  static async create(): Promise<Workspace> {
    // realpath: compilers report resolved paths, and macOS links the temp directory elsewhere.
    return new Workspace(await realpath(await mkdtemp(join(tmpdir(), 'diffle-render-'))));
  }

  /** Writes `files` (relative paths) over the current set; resolves to the paths that changed. */
  async sync(files: ReadonlyMap<string, Buffer>): Promise<string[]> {
    const before = this.files;
    // Forget the set first: a write that fails midway leaves the directory unknown, and the next sync
    // then rewrites everything.
    this.files = new Map();
    const written = [...files].filter(([rel, buf]) => !before.get(rel)?.equals(buf));
    const removed = [...before.keys()].filter((rel) => !files.has(rel));
    // All at once: a watching compiler batches events that arrive together into one compile.
    await Promise.all([
      ...written.map(async ([rel, buf]) => {
        const abs = join(this.root, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, buf);
      }),
      ...removed.map((rel) => rm(join(this.root, rel), { force: true })),
    ]);
    this.files = new Map(files);
    return [...written.map(([rel]) => rel), ...removed];
  }

  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
