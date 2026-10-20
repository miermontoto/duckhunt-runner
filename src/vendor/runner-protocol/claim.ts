// forma del claim del cable legacy (contrato 42): lo que POST /api/runner/claim devuelve a un daemon, con
// trabajo (LegacyClaimBody) o sin él (LegacyIdleClaimBody, solo a un daemon con `logout`; al resto, 204), los
// valores del run sobre los que el daemon decide (kind, semilla, perfil, aislamiento) y el estado de la
// cabecera del 204. lo que el daemon solo enseña o loguea (tier, accepts, repoSource) viaja como string: su
// catálogo es del server. el orden de las claves del json lo fija quien lo emite (claim-kit.ts del server),
// no estos tipos: los fixtures lo comprueban byte a byte.

// investigate = run de reglas o manual sobre un entry; prompt = conversación libre desde /agents
// (t#378), su texto va en agent_run.prompt. en ambos los mensajes del usuario (respuestas,
// seguimientos, también sobre done/failed/canceled) re-encolan la MISMA fila: una conversación = un
// run. resume = HISTÓRICO: fila hija que abría una instrucción sobre un resultado ya entregado; ya
// no se crea, sigue en el tipo para leer las filas viejas (hilo con padre/hijos).
// el kind se lee como la SEMILLA de la conversación (t#465): prompt = el texto de la persona (de
// confianza, tier act desde el primer turno); el resto = una semilla de plantilla (la plantilla de
// investigación sobre un entry: contenido ajeno, tier investigate hasta que la persona escribe).
export const AGENT_RUN_KIND = {
  investigate: 'investigate',
  resume: 'resume',
  prompt: 'prompt',
} as const;
export type AgentRunKind = (typeof AGENT_RUN_KIND)[keyof typeof AGENT_RUN_KIND];
// semilla de una conversación (viaja informativa en el claim como run.seed): template = investigate y
// el resume histórico; prompt = kind prompt. el daemon 0.11 la leerá para el presupuesto (seed_budget).
export const AGENT_RUN_SEED = {
  template: 'template',
  prompt: 'prompt',
} as const;
export type AgentRunSeed = (typeof AGENT_RUN_SEED)[keyof typeof AGENT_RUN_SEED];

// perfil de tools de un prompt run. read = leer el repo + mcp de duckhunt (tier act); edit = además
// Bash/Edit/Write en el worktree de la conversación (git incluido: commit, push y pr SOLO si el prompt
// lo pide). lo aplica el cli (--allowedTools + --permission-mode HARNESS_PERMISSION_MODE, SIEMPRE
// explícito: omitido heredaría el bypassPermissions del usuario), no el texto del prompt.
export const AGENT_PROMPT_PROFILE = {
  read: 'read',
  edit: 'edit',
} as const;
export type AgentPromptProfile = (typeof AGENT_PROMPT_PROFILE)[keyof typeof AGENT_PROMPT_PROFILE];
// dónde trabaja un prompt run con repo, elegido al abrir la conversación y fijo en todos sus turnos:
// worktree = el conv-<id> aislado del daemon (sobre la rama elegida, lo de siempre); checkout = la
// copia de trabajo del usuario TAL CUAL (su rama actual y sus cambios sin commitear; la rama del run
// no aplica). el daemon serializa los runs que comparten checkout. una semilla de plantilla con repo
// nace worktree y NUNCA va al checkout (t#465): el claim la manda como conversación de lectura, así que
// `worktree: false` y skip-permissions de la config local del daemon ya no le aplican. null = sin repo
// (o fila de reglas anterior a t#465: el claim la trata como worktree).
export const AGENT_RUN_ISOLATION = {
  worktree: 'worktree',
  checkout: 'checkout',
} as const;
export type AgentRunIsolation = (typeof AGENT_RUN_ISOLATION)[keyof typeof AGENT_RUN_ISOLATION];

// estado del daemon que el claim le dice en una cabecera de su 204 (t#465). upgrade_required = no
// anuncia `prompt` y no va a recibir trabajo; paused = la persona o esta máquina están en pausa; full
// = la máquina ya corre tantos runs como su tope de slots (t#465 P9); disabled = la instancia no deja
// ejecutar (agentes desactivados, o un miembro con la puerta de máquinas cerrada: t#465 P21). un daemon
// que no la conoce la ignora (sigue en 204: 0.10.2 ni la lee, 0.11.0 la guarda tal cual para `status`).
// a uno con RUNNER_CAPABILITY.logout (>= 0.11) el claim sin trabajo le responde 200 { run: null, runner,
// state } con la misma cabecera.
export const RUNNER_STATE_HEADER = 'x-duckhunt-runner-state';
export const RUNNER_STATE = { upgradeRequired: 'upgrade_required', paused: 'paused', full: 'full', disabled: 'disabled' } as const;
export type RunnerState = (typeof RUNNER_STATE)[keyof typeof RUNNER_STATE];

/** aws del run: la cuenta (null si el entry solo trae región) y la región. */
export interface LegacyClaimAws {
  accountId: string | null;
  region: string | null;
}

/** el run reclamado y su segmento. */
export interface LegacyClaimRun {
  id: number;
  kind: AgentRunKind;
  seed: AgentRunSeed;
  entryId: number;
  workspaceId: number;
  // clave del repo en la grafía del mapa de ESTA máquina (null = sin repo).
  repo: string | null;
  branch: string | null;
  repoSource: string;
  repoAvailable: boolean;
  aws: LegacyClaimAws | null;
  // solo cuando hay sesión que retomar en esta máquina: el daemon pasa `--resume` si y solo si viene.
  sessionId: string | null;
  parentRunId: number | null;
  profile: AgentPromptProfile;
  // null = sin repo.
  isolation: AgentRunIsolation | null;
  // null = un server anterior a los segmentos.
  segment: number | null;
  // solo a un daemon con RUNNER_CAPABILITY.model: alias o id del modelo, null = el de la máquina.
  model?: string | null;
}

/** cadencia y topes del feed de progreso (events.ts) para este run. */
export interface LegacyClaimEvents {
  enabled: boolean;
  nextSeq: number;
  flushMs: number;
  flushCount: number;
  batchMax: number;
  bodyMaxChars: number;
  toolArgMaxChars: number;
}

/** el mcp de la plataforma con el token per-run (expiresAt en ms desde epoch). */
export interface LegacyClaimMcp {
  serverName: string;
  url: string;
  token: string;
  expiresAt: number;
}

/** la máquina tal como la fijó la persona (solo a un daemon con RUNNER_CAPABILITY.logout). */
export interface LegacyClaimRunner {
  id: number;
  // el que le puso la persona (null = el daemon enseña su etiqueta).
  name: string | null;
  paused: boolean;
  accepts: string;
  maxSlots: number | null;
}

/** el claim con trabajo. */
export interface LegacyClaimBody {
  run: LegacyClaimRun;
  prompt: string;
  // el prompt con el que arrancar de cero si la sesión no se puede reanudar.
  fallbackPrompt: string | null;
  // informativo: quien manda es `tools`.
  tier: string;
  tools: { allowed: string[]; disallowed: string[] };
  permissionMode: string;
  // null desde t#465 P15 (un server anterior mandaba el tope de turnos); null = no pasar el flag.
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  timeoutMs: number;
  heartbeatMs: number;
  events: LegacyClaimEvents;
  mcp: LegacyClaimMcp;
  runner?: LegacyClaimRunner;
}

/** el claim sin trabajo a un daemon con RUNNER_CAPABILITY.logout: 200 con su fila y el estado (null = nada en cola que acepte). */
export interface LegacyIdleClaimBody {
  run: null;
  runner: LegacyClaimRunner;
  state: RunnerState | null;
}
