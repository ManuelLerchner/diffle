/** A prose word of a source file and the 1-based line it sits on. */
export interface SourceToken {
  token: string;
  line: number;
}

export type Compiled =
  | {
      ok: true;
      pdf: Buffer;
      /** Files the compile read, relative to its root; empty when the compiler does not say. */
      inputs: string[];
    }
  | {
      ok: false;
      /** The compiler's diagnostics, for the reader. */
      message: string;
      /** The file the first error is in, relative to its root. */
      file?: string;
    };

/**
 * A document format whose sources compile to a PDF. `RenderPipeline` owns everything else: copying
 * each side out of the snapshot, caching, reading and diffing the PDFs, anchoring comments.
 */
export interface Renderer {
  /** Compiler, version and flags, which key cached renders: any of them may change the layout. */
  version(): Promise<string>;
  /**
   * Compiles `entry`, a path relative to `root`, with `root` as everything the document may read.
   * Each surface compiles in one `root` for the whole run, so a renderer may keep a compiler warm on
   * it. `write` brings `root` to the files of this compile and resolves to the paths it changed; the
   * renderer calls it once, before reading any of them.
   */
  compile(root: string, entry: string, write: () => Promise<string[]>): Promise<Compiled>;
  /** Stops what `compile` keeps running; in-flight compiles then resolve, failed or cold. */
  close?(): Promise<void>;
  /**
   * The prose words of a source file with their lines, for tracing rendered text back to it: markup,
   * comments and references left out. Null for a file that is not a source of this format.
   */
  proseTokens(path: string, contents: string): SourceToken[] | null;
  /**
   * The new source of one file with the old one's removed words put back in place, marked as removed,
   * for a render that shows removals inline. Absent when the format cannot; null for a file it leaves alone.
   */
  inline?(path: string, oldSource: string, newSource: string): string | null;
}
