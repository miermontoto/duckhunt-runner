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
// non-goals: el diff acumulado de la conversación (el hilo suma los turnos) y el cable v0 (su claim no lo lleva).

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

/** topes del diff de un turno que el server pide en el claim (solo a un daemon con turn_changes, perfil edit y repo). */
export interface LegacyClaimChanges {
  filesMax: number;
  filePatchMaxChars: number;
  patchMaxChars: number;
}

/** un fichero del diff de un turno. additions/deletions null = binario (git no cuenta líneas). */
export interface RunChangeFile {
  path: string;
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
}
