// cambios de código de un turno (t#514; el contrato, en el protocolo: changes.ts): el diff del árbol de trabajo
// entre el inicio y el final de un segmento, que el daemon sube a duckhunt antes de su /status para que el hilo
// enseñe qué ficheros tocó el run y cómo. solo si el claim trae el bloque `changes` (el server lo manda a un segmento
// de perfil edit con repo) y el cwd es un repo git.
// decisiones:
// - la foto es un tree de git hecho con un índice TEMPORAL (copia del real → `add -A` → `write-tree`): cuenta lo que
//   el agente creó o cambió con Bash o con un generador, respeta .gitignore (un .env ignorado nunca sale) y nunca
//   toca el índice del usuario ni su rama. deja objetos sueltos en el repo, que su gc se lleva.
// - el diff no depende de la config de git del usuario: prefijos a/ b/ fijos, sin color, sin diff externo ni
//   textconv (lanzarían programas suyos) y rutas sin comillas (core.quotePath=false): la web busca cada fichero
//   por su cabecera `diff --git a/<ruta> b/<ruta>`.
// - un fichero más largo que filePatchMaxChars, o que ya no cabe en patchMaxChars, viaja con su cabecera sola (sin
//   hunks): sale en la lista con sus recuentos y sin cuerpo. la cabecera también cuenta contra patchMaxChars: si ni
//   ella cabe, el fichero se queda fuera del patch (sigue en la lista). tras un cambio de rama en el worktree son
//   miles de ficheros y sus cabeceras solas pasaban del tope duro del server (400: el turno perdía el diff entero); lo
//   que pase de patchMaxChars el server lo recorta igual en la frontera de un fichero. secretos enmascarados ANTES de
//   medir, por fichero (maskDiffChunk: en los hunks de un fichero de código no confunde `password: string` con un
//   secreto; en todo lo demás, el del feed entero). las rutas no son código: siempre el entero (maskDiffText). el
//   server lo repite.
// - nunca tumba el run: un git que falla deja el turno sin diff y una línea en el log.
// - en checkout la foto incluye lo que la persona edite a la vez en su copia: se acepta (está en el contrato).
// - repos adicionales (t#597, con `changes.extraRepos`): cada worktree adicional con su foto y su diff, en el MISMO
//   informe: sus ficheros llevan `repo` y sus cabeceras van bajo él (`a/<repo>/<ruta>`, extraRepoPatchPath del
//   protocolo). los topes son del informe entero: el principal primero y cada adicional con lo que quede
//   (combineChanges).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { maskDiffChunk, maskDiffText } from './secret-mask.js';
import {
  extraRepoPatchPath,
  RUN_CHANGE_STATUS,
  RUN_CHANGES_PATH_MAX_CHARS,
  type LegacyClaimChanges,
  type RunChangeFile,
  type RunChangeStatus,
  type RunChangesReport,
} from './vendor/runner-protocol/index.js';

const execFileP = promisify(execFile);

// `add -A` puede hashear ficheros nuevos grandes: más holgado que el git local de worktree.ts.
const GIT_TIMEOUT_MS = 60_000;
// salida máxima de un git (el patch entero antes de recortar): más grande, el turno se queda sin diff.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const TMP_PREFIX = 'duckhunt-turn-';
// la copia del índice real se fecha este margen antes que él (ver snapshotTree): de más, solo se rehashea de más.
const RACY_MARGIN_MS = 1000;
const FILE_HEADER = 'diff --git ';
const STATUSES: ReadonlySet<string> = new Set(Object.values(RUN_CHANGE_STATUS));
// el diff de git sin nada de la config del usuario que cambie su forma o lance programas (ver cabecera).
const diffArgs = (repo: string | null): string[] => {
  const prefix = repo === null ? '' : extraRepoPatchPath(repo, '');
  return ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', `--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`];
};

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf-8' });
  return stdout;
}

/** foto del árbol de trabajo de `dir` como tree de git (lo que vería `add -A`), sin tocar su índice. null = git falló. */
export async function snapshotTree(dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    const index = path.join(tmp, 'index');
    const real = path.resolve(dir, (await git(dir, ['rev-parse', '--git-path', 'index'], env)).trim());
    // con la copia del índice real, `add -A` solo rehashea lo que cambió desde el último stat. la copia lleva el mtime
    // del real (un segundo antes, por si acaso): git lo usa para su protección racy (una entrada con mtime >= el del
    // índice se compara por contenido), y con el mtime de la copia («ahora») una edición del mismo tamaño en el mismo
    // segundo que su último stat pasaba por limpia y el turno perdía ese fichero.
    if (fs.existsSync(real)) {
      const { atime, mtimeMs } = fs.statSync(real);
      fs.copyFileSync(real, index);
      fs.utimesSync(index, atime, new Date(mtimeMs - RACY_MARGIN_MS));
    }
    const withIndex = { ...env, GIT_INDEX_FILE: index };
    await git(dir, ['add', '-A'], withIndex);
    return (await git(dir, ['write-tree'], withIndex)).trim() || null;
  } catch (err) {
    console.error(`[runner] foto del árbol de trabajo fallida: ${(err as Error).message}`);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const clipPath = (p: string): string => maskDiffText(p).slice(0, RUN_CHANGES_PATH_MAX_CHARS);
const lines = (n: string): number | null => (n === '-' ? null : Number.parseInt(n, 10) || 0);

/** ficheros de `git diff --name-status -z` (renombrados y copias llevan dos rutas). */
export function parseNameStatus(out: string): Array<{ status: RunChangeStatus; path: string; oldPath?: string }> {
  const tokens = out.split('\0');
  // cursor: cada entrada consume 2 tokens (3 un renombrado o una copia), así que un map no sirve.
  const files: Array<{ status: RunChangeStatus; path: string; oldPath?: string }> = [];
  let i = 0;
  while (i < tokens.length && tokens[i] !== '') {
    const letter = tokens[i]!.charAt(0);
    const twoPaths = letter === RUN_CHANGE_STATUS.renamed || letter === RUN_CHANGE_STATUS.copied;
    const status = (STATUSES.has(letter) ? letter : RUN_CHANGE_STATUS.modified) as RunChangeStatus;
    files.push(twoPaths ? { status, oldPath: tokens[i + 1]!, path: tokens[i + 2]! } : { status, path: tokens[i + 1]! });
    i += twoPaths ? 3 : 2;
  }
  return files;
}

/** líneas añadidas y quitadas por ruta final de `git diff --numstat -z` (null = binario). */
export function parseNumstat(out: string): Map<string, { additions: number | null; deletions: number | null }> {
  const tokens = out.split('\0');
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  let i = 0;
  while (i < tokens.length && tokens[i] !== '') {
    const [added = '0', deleted = '0', single = ''] = tokens[i]!.split('\t');
    // un renombrado deja la ruta vacía en la línea y manda vieja y nueva en los dos tokens siguientes.
    const p = single !== '' ? single : tokens[i + 2]!;
    stats.set(p, { additions: lines(added), deletions: lines(deleted) });
    i += single !== '' ? 1 : 3;
  }
  return stats;
}

/** el patch por fichero: cada `diff --git` hasta el siguiente, enmascarado, o su cabecera sola si no cabe; lo que ni
 *  así cabe en patchMaxChars se queda fuera. nunca pasa de patchMaxChars. */
export function budgetPatch(patch: string, limits: Pick<LegacyClaimChanges, 'filePatchMaxChars' | 'patchMaxChars'>): string {
  const chunks = patch
    .split(`\n${FILE_HEADER}`)
    .map((c, i) => (i === 0 ? c : `${FILE_HEADER}${c}`))
    .filter((c) => c.startsWith(FILE_HEADER));
  // un fichero más largo que su tope ni se enmascara: viaja su cabecera sola (el enmascarado, acotado a lo que cabe).
  const headerOf = (c: string): string => `${maskDiffText(c.split('\n', 1)[0]!)}\n`;
  // el acumulador es local y se muta: con miles de ficheros, copiarlo en cada paso era cuadrático.
  return chunks
    .reduce<{ out: string[]; used: number }>(
      (acc, raw) => {
        const header = headerOf(raw);
        // ni la cabecera cabe: fuera, sin enmascarar el cuerpo (el enmascarado empieza por esa misma cabecera). uno
        // posterior más corto aún puede caber.
        if (acc.used + header.length > limits.patchMaxChars) return acc;
        const masked = raw.length <= limits.filePatchMaxChars ? maskDiffChunk(raw).replace(/\n?$/, '\n') : null;
        const piece = masked !== null && acc.used + masked.length <= limits.patchMaxChars ? masked : header;
        acc.out.push(piece);
        acc.used += piece.length;
        return acc;
      },
      { out: [], used: 0 },
    )
    .out.join('');
}

/** el diff entre dos fotos del árbol con los topes del claim; null = nada cambió o git falló. `repo` = el de un repo
 *  adicional (t#597): sus ficheros lo llevan y sus cabeceras van bajo él. */
export async function diffTrees(
  dir: string,
  env: NodeJS.ProcessEnv,
  from: string,
  to: string,
  limits: LegacyClaimChanges,
  repo: string | null = null,
): Promise<RunChangesReport | null> {
  if (from === to) return null;
  const DIFF = diffArgs(repo);
  try {
    const [nameStatus, numstat, patch] = await Promise.all([
      git(dir, [...DIFF, '--name-status', '-z', from, to], env),
      git(dir, [...DIFF, '--numstat', '-z', from, to], env),
      git(dir, [...DIFF, from, to], env),
    ]);
    const stats = parseNumstat(numstat);
    const all = parseNameStatus(nameStatus);
    if (all.length === 0) return null;
    const files: RunChangeFile[] = all.slice(0, limits.filesMax).map((f) => ({
      path: clipPath(f.path),
      ...(repo !== null ? { repo } : {}),
      ...(f.oldPath !== undefined ? { oldPath: clipPath(f.oldPath) } : {}),
      status: f.status,
      ...(stats.get(f.path) ?? { additions: null, deletions: null }),
    }));
    return { files, filesTotal: all.length, patch: budgetPatch(patch, limits) };
  } catch (err) {
    console.error(`[runner] diff del turno fallido: ${(err as Error).message}`);
    return null;
  }
}

/** foto del final del turno + su diff contra la del principio (`repo` = el de un repo adicional, ver diffTrees). */
export async function turnChanges(
  dir: string,
  env: NodeJS.ProcessEnv,
  from: string,
  limits: LegacyClaimChanges,
  repo: string | null = null,
): Promise<RunChangesReport | null> {
  const to = await snapshotTree(dir, env);
  return to === null ? null : diffTrees(dir, env, from, to, limits, repo);
}

/** los topes que le quedan a un repo adicional tras lo que ya ocupa el informe (ver cabecera). */
export const remainingLimits = (limits: LegacyClaimChanges, used: RunChangesReport | null): LegacyClaimChanges => ({
  ...limits,
  filesMax: Math.max(0, limits.filesMax - (used?.files.length ?? 0)),
  patchMaxChars: Math.max(0, limits.patchMaxChars - (used?.patch.length ?? 0)),
});

/** el informe del turno con los de los repos adicionales detrás (null = ninguno cambió). puro. */
export function combineChanges(reports: readonly (RunChangesReport | null)[]): RunChangesReport | null {
  const present = reports.filter((r): r is RunChangesReport => r !== null);
  if (present.length === 0) return null;
  return {
    files: present.flatMap((r) => r.files),
    filesTotal: present.reduce((n, r) => n + r.filesTotal, 0),
    patch: present.map((r) => r.patch).join(''),
  };
}
