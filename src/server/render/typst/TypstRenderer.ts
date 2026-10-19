import type { Compiled, Renderer } from '@/server/render/Renderer.js';
import { compileTypst, typstVersion } from './compile.js';

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
}
