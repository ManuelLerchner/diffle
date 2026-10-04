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
    };

/**
 * A document format whose sources compile to a PDF. `RenderPipeline` owns everything else: copying
 * each side out of the snapshot, caching, reading and diffing the PDFs, anchoring comments.
 */
export interface Renderer {
  /** Compiler and version, which key cached renders: another compiler may lay out differently. */
  version(): Promise<string>;
  /** Compiles `entry`, a path relative to `root`, with `root` as everything the document may read. */
  compile(root: string, entry: string): Promise<Compiled>;
  /**
   * The prose words of a source file with their lines, for tracing rendered text back to it: markup,
   * comments and references left out. Null for a file that is not a source of this format.
   */
  proseTokens(path: string, contents: string): SourceToken[] | null;
}
