// seam de plataforma (t#495, M6): todo lo que el daemon le dice a quien le encarga runs (reclamar, latir, el
// progreso, el feed, el cierre, las conversaciones abiertas, los comandos de repos y desvincularse) pasa por esta
// interfaz. hoy la implementan duckhunt-42 (duckhunt42.ts) y la spec v0 (v0.ts, t#495 M4), ambas sobre http
// (http-transport.ts); la plataforma local en proceso será otra implementación de la misma interfaz.
// decisiones:
// - la plataforma traduce su cable a lo que el daemon entiende (un claim ya parseado, un veredicto de latido, si
//   hay comandos pendientes) y loguea lo que es de su cable (un http de error, un json ilegible). el daemon decide
//   qué hacer con el run, los slots y la máquina.
// - una credencial muerta (desvinculada, revocada, caducada) se lanza como PlatformRejectedError desde cualquier
//   método: el daemon deja de usar ESA plataforma sin reintentar.
// - el segmento viaja como el objeto de siempre ({ segment } o {}): el cuerpo legacy lo esparce tal cual.

import type { ClaimResponse } from '../claim.js';
import type { RunnerCredential } from '../config.js';
import type { SeqEvent } from '../event-uploader.js';
import type { RepoCommand, RepoCommandResult } from '../repo-commands.js';
import type { RepoChoice, RepoIssue } from '../resources/repo/health.js';
import type { KeptWorktree, RunnerBlock } from '../server-state.js';
import type { StatusReport } from '../status-report.js';
import type { Exposure, ToolsetCeiling } from './types.js';

export const PROTOCOL = {
  duckhunt42: 'duckhunt-42',
  v0: 'agent-runner/0',
  local: 'local',
} as const;
export type Protocol = (typeof PROTOCOL)[keyof typeof PROTOCOL];

/** la credencial de la plataforma ya no vale: sin un `login` nuevo no vuelve. `clientId` = la que rechazó (el daemon
 *  la borra del fichero si sigue siendo esa); sin él, no se borra nada. */
export class PlatformRejectedError extends Error {
  constructor(
    message: string,
    readonly clientId?: string,
  ) {
    super(message);
    this.name = 'PlatformRejectedError';
  }
}

/** segmento del run en cada llamada (servers anteriores a los segmentos: {}). */
export type RunSegment = { segment?: number };

/** lo que la máquina anuncia a la plataforma en cada claim (sin paths: claves, recuentos y salud). */
export interface ClaimAnnounce {
  label: string;
  machineId: string | null;
  capabilities: readonly string[];
  slots: number;
  version: string | null;
  claudeVersion: string | null;
  repos: readonly string[];
  // null = aún sin chequeo que haya terminado: no se manda (nunca un [] que se leería como "todo sano").
  repoIssues: readonly RepoIssue[] | null;
  repoCandidates: readonly RepoChoice[] | null;
  // ids de cuenta aws expuestos (los que conoce el cable legacy).
  awsAccounts: readonly string[];
  // todas las claves aws expuestas, `default` incluida (las anuncia el cable v0 como recursos).
  awsKeys: readonly string[];
  // expone su identidad aws por defecto (el cable legacy la anuncia aparte, LegacyClaimAwsDefault del protocolo).
  // null = no se anuncia (el interruptor del flip de toolset_v1: el cable sin el flip).
  awsDefault: boolean | null;
  // sesiones de navegador expuestas a la plataforma y su salud (t#495, M7; códigos de health.ts). null = no se anuncian
  // (ninguna expuesta, o el interruptor del flip: el cable sin el flip).
  browsers: { keys: readonly string[]; health: readonly { key: string; kind: string }[] } | null;
  // null = el gc aún no recogió: no se anuncia.
  kept: readonly KeptWorktree[] | null;
}

/** lo que la plataforma dijo de esta máquina al reclamar (server-state.ts). */
export interface ServerSaid {
  state: string | null;
  runner: RunnerBlock | null;
}

export const CLAIM_RESULT = {
  run: 'run',
  idle: 'idle',
  invalid: 'invalid',
  unavailable: 'unavailable',
} as const;

/** run = un claim listo; idle = sin trabajo (o en pausa, sin slot…); invalid = un run reclamado que no se puede
 *  ejecutar (se cierra como failed); unavailable = sin respuesta útil (red, http de error). */
export type ClaimResult = { commandsPending: boolean } & (
  | { kind: typeof CLAIM_RESULT.run; claim: ClaimResponse; said: ServerSaid }
  | { kind: typeof CLAIM_RESULT.idle; said: ServerSaid }
  | { kind: typeof CLAIM_RESULT.invalid; runId: string | null; error: string; said: ServerSaid }
  | { kind: typeof CLAIM_RESULT.unavailable }
);

/** latido de un run: seguir, o pararlo con el motivo (para el log). */
export type HeartbeatVerdict = { stop: false } | { stop: true; reason: string };

/** qué dijo la plataforma al desvincular: desvinculada (con los runs que canceló), sin el endpoint, o la
 *  credencial ya no valía. */
export type UnpairOutcome = { kind: 'unpaired'; canceled: number } | { kind: 'unsupported' } | { kind: 'gone' };

export interface Platform {
  readonly id: string;
  readonly protocol: Protocol;
  /** a quién y con qué credencial habla (server-state.ts, logs). */
  identity(): { baseUrl: string; clientId: string };
  /** la credencial del fichero tras recargarlo: un `login` nuevo de la misma instancia se adopta. */
  observe(credential: RunnerCredential): void;
  claim(a: ClaimAnnounce): Promise<ClaimResult>;
  heartbeat(runId: string, seg: RunSegment): Promise<HeartbeatVerdict>;
  /** lanza si no llegó (el daemon lo loguea: fuego y olvido). */
  progress(runId: string, toolCalls: number, seg: RunSegment, workdir?: string): Promise<void>;
  /** status http del lote (EventUploader decide reintentar o parar). lanza en error de red. */
  events(runId: string, events: SeqEvent[], seg: RunSegment): Promise<number>;
  /** cierre del segmento con reintento acotado; nunca lanza (lo que no llega lo cierra el server). */
  result(runId: string, report: StatusReport): Promise<void>;
  /** de estas conversaciones, las que siguen abiertas (lo que no sepa, abierto: el gc solo aplica el ttl). */
  openConversations(runIds: string[]): Promise<Set<string>>;
  /** comandos de repos pendientes (null = no se pudieron pedir). */
  commands(label: string): Promise<RepoCommand[] | null>;
  ackCommands(results: RepoCommandResult[]): Promise<void>;
  unpair(): Promise<UnpairOutcome>;
}

/** lo que una plataforma que MANDA con toolset_v1 (v0) necesita de la máquina para aplicar un claim: el techo y la
 *  exposición que el usuario le puso (de la config de AHORA), los tipos de recurso que sirve este daemon y si tiene
 *  la aws cli. el cable legacy no lo usa: allí mandan las listas de tools del server. */
export interface PlatformContext {
  enforcement(): { ceiling: ToolsetCeiling; expose: Readonly<Record<string, Exposure>>; resourceTypes: readonly string[]; awsCli: boolean };
}

/** crea la plataforma de un id con su credencial (y lo que necesita de la máquina). una por protocolo que este
 *  runner habla. */
export type PlatformFactory = (id: string, credential: RunnerCredential, ctx?: PlatformContext) => Platform;
export type PlatformFactories = Readonly<Partial<Record<Protocol, PlatformFactory>>>;
