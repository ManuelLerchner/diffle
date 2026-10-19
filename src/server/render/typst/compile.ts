import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Compiled } from '@/server/render/Renderer.js';

/** Diagnostics kept from a failed compile: enough for every error of a broken edit. */
const MAX_STDERR = 16 * 1024;
/** A compile that runs this long is hung, not slow. */
const TIMEOUT_MS = 5 * 60_000;

/**
 * Compiles `entry` (relative to `root`) into `root/.diffle-out.pdf`, with `root` as Typst's project
 * root so the document reads nothing beside the tree it was given.
 */
export function compileTypst(root: string, entry: string, command = 'typst'): Promise<Compiled> {
  const out = join(root, '.diffle-out.pdf');
  // `sys.inputs.diffle` lets a document tell a review render from its own builds, e.g. to stand in for
  // generated data no revision contains.
  const args = ['compile', '--root', root, '--input', 'diffle=1'];
  args.push('--diagnostic-format', 'short', join(root, entry), out);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        message: e.code === 'ENOENT' ? `${command} is not on PATH: install Typst to render the document` : e.message,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const why = signal ? `typst was stopped (${signal})` : `typst exited with ${code}`;
        resolve({ ok: false, message: relativize(stderr.trim(), root) || why });
        return;
      }
      readFile(out).then(
        (pdf) => resolve({ ok: true, pdf }),
        (e: Error) => resolve({ ok: false, message: e.message }),
      );
    });
  });
}

/** Diagnostics name the temporary copy; the reader knows the files by their place in the project. */
function relativize(message: string, root: string): string {
  return message.split(`${root}${sep}`).join('').split(root).join('.');
}

/** The compiler's version line, which keys cached renders: another compiler may lay out differently. */
export function typstVersion(command = 'typst'): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 10_000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}
