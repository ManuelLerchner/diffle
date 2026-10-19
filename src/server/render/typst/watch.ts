import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import type { Compiled } from '@/server/render/Renderer.js';
import { compileTypst, depInputs, failure, MAX_STDERR, outputs, relativize, TIMEOUT_MS, typstArgs } from './compile.js';

/** Typst batches file events for about 100ms; a compile not started by then missed the change. */
const START_MS = 2_000;
/** Diagnostics follow an error status with no end marker: this much silence ends them. */
const QUIET_MS = 50;
/** The dependency list is written just after the status line that announces the compile. */
const DEPS_MS = 500;

const STATUS = /^\[[\d:]+\] (?:compiling \.\.\.|compiled (successfully|with warnings|with errors)\b.*)$/;
/** Printed again before every status line. */
const HEADER = /^(?:watching|writing to) /;

/** Watchers outlive nothing: an idle one never writes, so it would not notice its parent is gone. */
const children = new Set<ChildProcess>();
process.once('exit', () => children.forEach((c) => c.kill()));

interface Waiter {
  /** Settled by the first compile to start after this many had. */
  after: number;
  settle: (compiled: Compiled | null) => void;
}

/**
 * A `typst watch` kept running on one root. Typst keeps its incremental caches between compiles, so an
 * edit recompiles in a fraction of a cold compile's time. Whatever the watcher cannot answer (it is not
 * running yet, missed the change, or died) is compiled cold in a fresh process instead.
 */
export class TypstWatch {
  private child: ChildProcess | null = null;
  /** Compiles the watcher has started; each compile is known by its count. */
  private started = 0;
  /** The compile under way, and its diagnostics once it reported errors. */
  private running: { n: number; diagnostics: string | null } | null = null;
  private quiet: NodeJS.Timeout | null = null;
  private last: { n: number; compiled: Compiled } | null = null;
  /** The files the last compile read, relative to the root; null when unknown. */
  private inputs: Set<string> | null = null;
  private waiters = new Set<Waiter>();
  private partial = '';
  private stopped = false;

  constructor(
    private readonly command: string,
    private readonly root: string,
    private readonly entry: string,
  ) {}

  /** Brings the root to the next file set with `write`, then compiles it. */
  async compile(write: () => Promise<string[]>): Promise<Compiled> {
    if (this.stopped) return STOPPED;
    const after = this.started;
    // Taken before the write, so a compile it triggers cannot slip past unseen.
    const last = this.last?.compiled;
    const inputs = this.inputs;
    // A dependency list on disk then belongs to a compile of these files.
    await rm(outputs(this.root, 'watch').deps, { force: true });
    const changed = await write();
    if (!this.child) this.spawn();
    // The watcher recompiles only for files the document read, and only those can change its output.
    else if (last && (changed.length === 0 || (last.ok && inputs && !changed.some((p) => inputs.has(p))))) return last;
    const compiled = await this.next(after);
    if (compiled) return compiled;
    return this.stopped ? STOPPED : compileTypst(this.root, this.entry, this.command);
  }

  /** Stops the watcher for good; compiles waiting on it fail rather than compile cold. */
  stop(): void {
    this.stopped = true;
    this.kill();
  }

  private kill(): void {
    const child = this.child;
    if (!child) return;
    child.kill();
    this.exited(child);
  }

  private spawn(): void {
    const child = spawn(this.command, typstArgs('watch', this.root, this.entry), {
      cwd: this.root,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    children.add(child);
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      const lines = (this.partial + chunk).split('\n');
      this.partial = lines.pop()!;
      for (const line of lines) this.line(line.trimEnd());
    });
    // A missing compiler fails the cold compile too, which says so.
    child.on('error', () => this.exited(child));
    child.on('close', () => this.exited(child));
  }

  private line(line: string): void {
    const status = STATUS.exec(line);
    if (!status) {
      const run = this.running;
      if (run?.diagnostics == null || !line || HEADER.test(line)) return;
      if (run.diagnostics.length < MAX_STDERR) run.diagnostics += `${line}\n`;
      this.armQuiet();
      return;
    }
    this.endDiagnostics();
    const [, outcome] = status;
    if (outcome == null) {
      this.running = { n: ++this.started, diagnostics: null };
    } else if (outcome === 'with errors') {
      if (this.running) this.running.diagnostics = '';
      this.armQuiet();
    } else if (this.running) {
      const { n } = this.running;
      this.running = null;
      void this.succeeded(n);
    }
  }

  private armQuiet(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.endDiagnostics(), QUIET_MS);
  }

  /** Settles a compile that reported errors, with the diagnostics printed since. */
  private endDiagnostics(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    const run = this.running;
    if (run?.diagnostics == null) return;
    this.running = null;
    this.finish(run.n, failure(relativize(run.diagnostics.trim(), this.root) || 'typst reported errors'), null);
  }

  private async succeeded(n: number): Promise<void> {
    const out = outputs(this.root, 'watch');
    try {
      const [pdf, json] = await Promise.all([readFile(out.pdf), awaitDeps(out.deps, DEPS_MS)]);
      const inputs = json == null ? [] : depInputs(json, this.root);
      // No list says nothing about what the document read.
      this.finish(n, { ok: true, pdf, inputs }, inputs.length ? new Set(inputs) : null);
    } catch (e) {
      this.finish(n, { ok: false, message: `cannot read typst's output: ${(e as Error).message}` }, null);
    }
  }

  private finish(n: number, compiled: Compiled, inputs: Set<string> | null): void {
    // Outputs are read asynchronously; a later compile's result stands.
    if (this.last && this.last.n > n) return;
    this.last = { n, compiled };
    this.inputs = inputs;
    for (const w of this.waiters) if (n > w.after) w.settle(compiled);
  }

  /** The result of the first compile to start after the `after`th; null when the watcher cannot give one. */
  private next(after: number): Promise<Compiled | null> {
    if (this.last && this.last.n > after) return Promise.resolve(this.last.compiled);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        after,
        settle: (compiled) => {
          clearTimeout(missed);
          clearTimeout(hung);
          this.waiters.delete(waiter);
          resolve(compiled);
        },
      };
      const missed = setTimeout(() => this.started <= after && waiter.settle(null), START_MS);
      const hung = setTimeout(() => this.kill(), TIMEOUT_MS);
      this.waiters.add(waiter);
    });
  }

  private exited(child: ChildProcess): void {
    children.delete(child);
    if (this.child !== child) return;
    this.child = null;
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    this.running = null;
    this.partial = '';
    this.last = null;
    this.inputs = null;
    for (const w of this.waiters) w.settle(null);
  }
}

const STOPPED: Compiled = { ok: false, message: 'rendering stopped' };

/** The dependency list once Typst has written it whole, polling for up to `ms`; null if it never is. */
async function awaitDeps(path: string, ms: number): Promise<string | null> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const json = await readFile(path, 'utf8');
      JSON.parse(json);
      return json;
    } catch {
      if (Date.now() >= until) return null;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
