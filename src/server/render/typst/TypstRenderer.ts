import type { Compiled, Renderer, SourceToken } from '@/server/render/Renderer.js';
import { combineSource } from './combine.js';
import { compileTypst, typstVersion } from './compile.js';
import { typstProse } from './prose.js';

/** Typst documents, compiled with the `typst` CLI. */
export class TypstRenderer implements Renderer {
  private versionLine: Promise<string> | null = null;

  constructor(private readonly command = 'typst') {}

  version(): Promise<string> {
    this.versionLine ??= typstVersion(this.command);
    return this.versionLine;
  }

  compile(root: string, entry: string): Promise<Compiled> {
    return compileTypst(root, entry, this.command);
  }

  proseTokens(path: string, contents: string): SourceToken[] | null {
    return path.endsWith('.typ') ? typstProse(contents) : null;
  }

  inline(path: string, oldSource: string, newSource: string): string | null {
    return path.endsWith('.typ') ? combineSource(oldSource, newSource) : null;
  }
}
