import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, posix, relative, resolve as resolvePath, sep } from 'node:path';
import type { Compiled } from '@/server/render/Renderer.js';

/** Diagnostics kept from a failed compile: enough for every error of a broken edit. */
export const MAX_STDERR = 16 * 1024;
/** A compile that runs this long is hung, not slow. */
export const TIMEOUT_MS = 5 * 60_000;

type Mode = 'compile' | 'watch';

/** Where a `typst compile` or `typst watch` under `root` writes; apart, so the two never share a file. */
export function outputs(root: string, mode: Mode): { pdf: string; deps: string } {
  return { pdf: join(root, `.diffle-${mode}.pdf`), deps: join(root, `.diffle-${mode}-deps.json`) };
}

/** A missing compiler, said so the reader knows what to install. */
export function spawnFailure(e: NodeJS.ErrnoException, command: string): Compiled {
  return {
    ok: false,
    message: e.code === 'ENOENT' ? `${command} is not on PATH: install Typst to render the document` : e.message,
  };
}

/**
 * Compiles `entry` (relative to `root`) in a fresh `typst` process, with `root` as Typst's project
 * root so the document reads nothing beside the tree it was given. `inputs` lists the files it read
 * inside `root`, relative to it; packages and fonts live outside and are left out.
 */
export function compileTypst(root: string, entry: string, command = 'typst'): Promise<Compiled> {
  const { pdf: out, deps } = outputs(root, 'compile');
  const args = typstArgs('compile', root, entry);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(spawnFailure(e, command));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const why = signal ? `typst was stopped (${signal})` : `typst exited with ${code}`;
        resolve(failure(relativize(stderr.trim(), root) || why));
        return;
      }
      void Promise.all([readFile(out), readFile(deps, 'utf8').catch(() => '{}')]).then(
        ([pdf, json]) => resolve({ ok: true, pdf, inputs: depInputs(json, root) }),
        (e: Error) => resolve({ ok: false, message: e.message }),
      );
    });
  });
}

/** A failed compile, with the erring file read off Typst's short diagnostics. */
export function failure(message: string): Compiled {
  const out: Compiled = { ok: false, message };
  const file = /^(?:\.\/)?([^:\n]+\.typ):\d+:\d+: error/m.exec(message)?.[1];
  if (file) out.file = posix.normalize(file.split(sep).join('/'));
  return out;
}

/** Diagnostics name the temporary copy; the reader knows the files by their place in the project. */
export function relativize(message: string, root: string): string {
  return message.split(`${root}${sep}`).join('').split(root).join('.');
}

export function depInputs(json: string, root: string): string[] {
  try {
    const { inputs } = JSON.parse(json) as { inputs?: unknown };
    if (!Array.isArray(inputs)) return [];
    return inputs
      .filter((p): p is string => typeof p === 'string')
      .map((p) => relative(root, resolvePath(root, p)))
      .filter((p) => p !== '' && !p.startsWith('..') && !isAbsolute(p))
      .map((p) => p.split(sep).join('/'));
  } catch {
    return [];
  }
}

/** The command line that compiles, or watches, `entry` under `root`. */
export function typstArgs(mode: Mode, root: string, entry: string): string[] {
  const out = outputs(root, mode);
  // `sys.inputs.diffle` lets a document tell a review render from its own builds, e.g. to stand in for
  // generated data no revision contains.
  const args = [mode, '--root', root, '--input', 'diffle=1'];
  args.push('--deps', out.deps, '--deps-format', 'json');
  // Fonts the project ships come with the tree. A `--font-path` replaces `TYPST_FONT_PATHS`, so keep its
  // directories too.
  for (const dir of [root, ...(process.env.TYPST_FONT_PATHS ?? '').split(delimiter).filter(Boolean)])
    args.push('--font-path', dir);
  args.push('--diagnostic-format', 'short', join(root, entry), out.pdf);
  return args;
}

/**
 * The compiler's version line and command line, which key cached renders: another compiler or other
 * flags may lay out differently.
 */
export function typstVersion(command = 'typst'): Promise<string> {
  const invocation = typstArgs('compile', '<root>', '<entry>').join(' ');
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? '' : `${stdout.trim()}\n${invocation}`),
    );
  });
}
