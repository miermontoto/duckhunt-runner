// kernel.yama.ptrace_scope de esta máquina (t#440 P6): una precondición de host para `token_isolation`. con 0, cualquier
// proceso del mismo usuario puede adjuntarse a otro (ptrace) y leerle la memoria, el token per-run del cli de un run
// hermano incluido; con 1 o más, solo a sus descendientes (o nadie). `status` lo enseña; fuera de linux, o sin yama,
// «n/a». ojo: yama no cubre /proc/<pid>/environ; que el token per-run no viaje en un env lo cubren los tests de t#652.

import fs from 'node:fs';

/** el fichero de yama (inyectable en las pruebas). */
export const PTRACE_SCOPE_FILE = '/proc/sys/kernel/yama/ptrace_scope';
/** lo que se enseña sin el valor. */
export const PTRACE_SCOPE_NA = 'n/a';
const SCOPE_RE = /^\d+$/;

/** el valor de kernel.yama.ptrace_scope (`0`…`3`), o «n/a» fuera de linux o sin yama. */
export function ptraceScope(platform: NodeJS.Platform = process.platform, file: string = PTRACE_SCOPE_FILE): string {
  if (platform !== 'linux') return PTRACE_SCOPE_NA;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    // sin yama (kernel sin el lsm) o un /proc que no lo expone: no hay valor que enseñar.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return PTRACE_SCOPE_NA;
    throw new Error(`no se pudo leer ${file}: ${(err as Error).message}`);
  }
  return SCOPE_RE.test(raw) ? raw : PTRACE_SCOPE_NA;
}
