// volver atrás en una conversación (t#564): «editar y reenviar» un mensaje de la persona = la conversación sigue desde
// justo antes de él, como si lo de después no hubiera pasado, y opcionalmente con los ficheros del worktree como
// estaban entonces.
// decisiones:
// - la conversación la vuelve atrás el cli: `--resume <sesión> --resume-session-at <uuid> --fork-session` abre una
//   sesión NUEVA que solo conoce hasta el mensaje assistant con ese uuid; la original queda entera (verificado con
//   2.1.311). para saber dónde acabó cada turno, el daemon con RUNNER_CAPABILITY.rewind devuelve en el status de cada
//   segmento el uuid de su último mensaje assistant (`lastMessageUuid`) y acepta `run.resumeAt` en el claim.
// - el coste no cambia de fórmula: el fork reporta el total acumulado de la sesión madre más lo suyo y el daemon
//   marca el segmento como resumed, así que base + reportado sigue contando bien (verificado).
// - los ficheros NO los vuelve atrás el cli: `--rewind-files` en headless graba snapshots vacíos. con
//   RUNNER_CAPABILITY.rewindFiles el daemon devuelve en el status de un segmento de edición con repo el árbol git que
//   fotografió al empezar (`startTree`, el de turn-changes) y el HEAD de entonces (`startHead`), y restaura ese árbol
//   en el worktree ANTES del turno cuando el claim trae `restore`. nunca en el checkout de la persona, nunca si HEAD
//   cambió desde entonces (habría commits del agente por medio) ni si el árbol ya no está: el segmento falla con su
//   motivo sin lanzar el cli.
// non-goals: deshacer lo que el agente hizo FUERA del worktree (duckhunt, jira, un push) y volver atrás en el cable v0.

/** cli mínimo con --resume-session-at y --fork-session (flag oculto del --help: el daemon lo decide por versión). */
export const REWIND_CLI_MIN_VERSION = '2.1.311';

/** uuid de un mensaje del cli (el `uuid` de los eventos assistant del stream-json). */
export const RUN_MESSAGE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** id de un objeto git (sha-1 o sha-256). */
export const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** lo que el claim pide restaurar antes del turno: el árbol que el daemon fotografió y el HEAD que tenía entonces. */
export interface LegacyClaimRestore {
  tree: string;
  head: string;
}

/** lo que añade al status de un segmento un daemon con rewind (todo opcional: sin él, el status de siempre). */
export interface RewindStatusFields {
  // uuid del último mensaje assistant del segmento (dónde se puede volver).
  lastMessageUuid?: string;
  // con rewind_files y en un segmento de edición con repo: el árbol y el HEAD al empezarlo.
  startTree?: string;
  startHead?: string;
}

/** motivo de un segmento que no pudo restaurar los ficheros (va en el error del status). */
export const REWIND_RESTORE_ERROR = 'restore_failed';
