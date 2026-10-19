import type { Compiled, Renderer, SourceToken } from '@/server/render/Renderer.js';
import { combineSource } from './combine.js';
import { typstVersion } from './compile.js';
import { typstProse } from './prose.js';
import { TypstWatch } from './watch.js';

/** Typst documents, compiled with the `typst` CLI: one warm `typst watch` per root. */
export class TypstRenderer implements Renderer {
  private versionLine: Promise<string> | null = null;
  private watches = new Map<string, TypstWatch>();

  constructor(private readonly command = 'typst') {}

  version(): Promise<string> {
    this.versionLine ??= typstVersion(this.command);
    return this.versionLine;
  }

  compile(root: string, entry: string, write: () => Promise<string[]>): Promise<Compiled> {
    let watch = this.watches.get(root);
    if (!watch) this.watches.set(root, (watch = new TypstWatch(this.command, root, entry)));
    return watch.compile(write);
  }

  async close(): Promise<void> {
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
  }

  proseTokens(path: string, contents: string): SourceToken[] | null {
    return path.endsWith('.typ') ? typstProse(contents) : null;
  }

  inline(path: string, oldSource: string, newSource: string): string | null {
    return path.endsWith('.typ') ? combineSource(oldSource, newSource) : null;
  }
}
