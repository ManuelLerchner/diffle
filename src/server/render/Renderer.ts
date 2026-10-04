export type Compiled =
  | { ok: true; pdf: Buffer }
  | { ok: false; /** The compiler's diagnostics, for the reader. */ message: string };

/**
 * A document format whose sources compile to a PDF. `RenderPipeline` owns everything else: copying
 * each side out of the snapshot, caching, reading and diffing the PDFs.
 */
export interface Renderer {
  /** Compiler and version, which key cached renders: another compiler may lay out differently. */
  version(): Promise<string>;
  /** Compiles `entry`, a path relative to `root`, with `root` as everything the document may read. */
  compile(root: string, entry: string): Promise<Compiled>;
}
