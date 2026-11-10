// cambios de código de un turno (t#514): el diff del árbol de trabajo entre el inicio y el final de un segmento, que
// el daemon sube a POST /api/runner/runs/:id/changes para que el hilo de /agents enseñe qué ficheros tocó el run y
// cómo. es la ÚNICA excepción al «nunca contenido de ficheros» del feed (events.ts): un canal aparte, con su propia
// capability y sus topes, que solo ve el dueño del run.
// decisiones:
// - lo pide el server: el bloque `changes` del claim (LegacyClaimChanges) solo viaja a quien anuncia
//   RUNNER_CAPABILITY.turnChanges y solo en un segmento de perfil edit con repo. sin bloque, el daemon no mira nada.
// - foto del árbol con un índice temporal (`add -A` + `write-tree`): respeta .gitignore (un .env ignorado nunca
//   sale), cuenta lo creado con Bash o por un generador y nunca toca el índice del usuario.
// - patch = diff unificado de git (`diff --git` por fichero), con los ficheros sin cuerpo (binarios, enormes o fuera
//   del presupuesto) como su cabecera sola: el hilo los lista por `files` igual.
// - el daemon enmascara secretos y recorta; el server lo hace OTRA VEZ (no puede verificar lo que llega, solo acotarlo).
// - en checkout (la copia de trabajo de la persona) la foto incluye lo que ella edite a la vez: se acepta.
// - repos adicionales (t#597, RUNNER_CAPABILITY.extraRepoChanges): con `extraRepos` en el bloque del claim, el daemon
//   fotografía también el worktree de cada repo adicional y sube sus ficheros en el MISMO informe: cada uno con su
//   `repo` (la clave del claim) y, en el patch, con las rutas de su cabecera bajo el repo (`diff --git a/<repo>/<ruta>
//   b/<repo>/<ruta>`: extraRepoPatchPath), así dos repos con la misma ruta no se confunden. los topes son del informe
//   entero (el principal primero).
// - diff neto de la conversación (t#642, RUNNER_CAPABILITY.runChanges): con `changes.run` en el claim, al cerrar cada
//   segmento el daemon sube además el diff de la foto BASE de la conversación al final, con `scope: run` (el server lo
//   guarda aparte: una fila por run, la última sustituye a la anterior). base = `run.since`, la foto del primer segmento
//   de edición que reportó su `startTree` desde ESTA máquina; sin `since` (es el primer turno de edición, el server aún
//   no tiene ninguna foto), la del primer turno del proceso. la base pasa por la misma corrección de un salto de HEAD
//   que la de un turno (`at` = cuándo se hizo esa foto). un tree base que ya no está en el repo (un gc) no sube nada; un
//   diff vacío sube un informe sin ficheros (lo hecho se deshizo). la base de otra máquina no viaja: allí sus trees no
//   existen y el server conserva el último informe.
// non-goals: el cable v0 (su claim no lo lleva).

// estado de un fichero en el turno (letras de `git diff --name-status`, sin el % de similitud).
export const RUN_CHANGE_STATUS = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
} as const;
export type RunChangeStatus = (typeof RUN_CHANGE_STATUS)[keyof typeof RUN_CHANGE_STATUS];

// ficheros que viajan por turno (más → se cortan y `filesTotal` dice cuántos había).
export const RUN_CHANGES_FILES_MAX = 300;
// largo de una ruta (relativa a la raíz del repo, nunca absoluta).
export const RUN_CHANGES_PATH_MAX_CHARS = 512;
// cuerpo de un fichero: más largo viaja sin él (un lockfile, un fichero generado).
export const RUN_CHANGES_FILE_PATCH_MAX_CHARS = 64_000;
// presupuesto del patch entero de un turno: los ficheros que no caben viajan sin cuerpo.
export const RUN_CHANGES_PATCH_MAX_CHARS = 256_000;
// patch crudo más largo que esto se rechaza (400): el daemon ya recorta al presupuesto.
export const RUN_CHANGES_PATCH_HARD_MAX_CHARS = 512_000;

/** la foto de un repo adicional con la que empezó la conversación (t#642): su clave, su tree y su HEAD. */
export interface RunDiffExtraBase {
  repo: string;
  tree: string;
  head: string;
}

/** la foto con la que empezó la conversación en esta máquina (t#642): tree, HEAD, cuándo (ms) y la de cada adicional. */
export interface RunDiffBase {
  tree: string;
  head: string;
  at: number;
  extras?: RunDiffExtraBase[];
}

/** el diff neto de la conversación (t#642, solo a un daemon con run_changes): sin `since`, la base es la del proceso. */
export interface LegacyClaimRunChanges {
  since?: RunDiffBase;
}

/** topes del diff de un turno que el server pide en el claim (solo a un daemon con turn_changes, perfil edit y repo). */
export interface LegacyClaimChanges {
  filesMax: number;
  filePatchMaxChars: number;
  patchMaxChars: number;
  // t#597: también los repos adicionales del run (solo a un daemon con extra_repo_changes y si el run los tiene).
  extraRepos?: true;
  // t#642: también el diff neto de la conversación, con los mismos topes.
  run?: LegacyClaimRunChanges;
}

/** qué cubre un informe de cambios: el turno (por defecto) o la conversación entera (t#642). */
export const RUN_CHANGES_SCOPE = { turn: 'turn', run: 'run' } as const;
export type RunChangesScope = (typeof RUN_CHANGES_SCOPE)[keyof typeof RUN_CHANGES_SCOPE];

/** la ruta de un fichero de un repo adicional en las cabeceras del patch (t#597): bajo la clave de su repo. */
export const extraRepoPatchPath = (repo: string, path: string): string => `${repo}/${path}`;

/** un fichero del diff de un turno. additions/deletions null = binario (git no cuenta líneas). */
export interface RunChangeFile {
  // ruta relativa a la raíz de SU repo.
  path: string;
  // t#597: el repo adicional del fichero (la clave del claim); ausente = el principal.
  repo?: string;
  // ruta anterior de un renombrado o una copia.
  oldPath?: string;
  status: RunChangeStatus;
  additions: number | null;
  deletions: number | null;
}

/** cuerpo de POST /api/runner/runs/:id/changes: el diff de un segmento, subido antes de su /status. */
export interface RunChangesReport {
  files: RunChangeFile[];
  // ficheros del diff antes de cortar a filesMax.
  filesTotal: number;
  // diff unificado de git (sin color ni diff externo); los ficheros sin cuerpo, solo su cabecera.
  patch: string;
  segment?: number;
  // t#642: ausente = el turno.
  scope?: RunChangesScope;
}
