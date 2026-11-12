// el seam de drivers (t#440 P1): lo único que el daemon sabe de un cli de agente. executeRun hace lo neutral
// (recursos, turnos del cwd, fotos del diff, feed, latido, auditoría, informe) y delega en el driver del backend lo
// propio del cli: qué anuncia, qué prepara por segmento, cómo se lanza, cómo se lee su salida y cómo se cierra.
// decisiones:
// - claude es el driver #0 y se envuelve EN SU SITIO (backends/claude/claude-driver.ts): sus módulos (claude.ts,
//   claude-args.ts, run-mcp-config.ts, live-session.ts, read-shell-guard.ts, user-permissions.ts, slash-commands.ts)
//   no se mueven, así el plan de lanzamiento, la salida y el cable quedan iguales byte a byte (spawn-plan.json,
//   claude-output.json, wire-legacy).
// - el proceso lo vigila spawn-agent.ts (grupo propio, latido del lease, timeout, stderr, log, progreso): la mitad
//   neutral de lo que era spawnClaude. el driver solo abre la sesión que lee su stdout.
// - los turnos dentro de un proceso vivo (t#636, fase 3) son del daemon: el driver le avisa con TurnEnded neutral
//   (`onTurnEnd`), nunca con el evento de su cli.
// - el informe sale del driver ya con la forma del status; recortarlo y enmascararlo es neutral (clampReport en la
//   plataforma) y vale para todo driver.
// - el claim sigue siendo el del cable legacy (ClaimResponse): el RunSpec neutral con su `legacy` aparte llega con el
//   cable de backends (P4), cuando un claim no-claude traiga solo su toolset.
// non-goals (P1): elegir driver por claim (todo va al de claude_code hasta P4), deny-paths neutral (P7, cuando codex
// necesite las rutas absolutas para su deny_read), vocabulario canónico de tools (P4/P7).

import type { Writable } from 'node:stream';
import type { AttemptFacts } from '../audit.js';
import type { ClaimResponse } from '../claim.js';
import type { EventUploader } from '../event-uploader.js';
import type { FeedContext } from '../feed.js';
import type { MaterializedRun, RunMcp } from '../resources/lifecycle.js';
import type { RunLease } from '../run-lease.js';
import type { SlashCommand } from '../vendor/runner-protocol/index.js';
import type { StatusReport } from '../status-report.js';
import type { RunInboxCommand, RunTurnReport } from '../vendor/runner-protocol/index.js';

/** lo que el daemon sabe de la máquina y de su config, de lo que dependen las capabilities de un driver. */
export interface HostFacts {
  hasAws: boolean;
  bypassPermissions: boolean;
  remoteRepoEdits: boolean | undefined;
  toolsetRender: boolean | undefined;
  browser: boolean;
}

/** lo que un `result` del agente principal cuenta de su turno (t#636, fase 3): el informe y el total de tool calls. */
export interface TurnEnded {
  // las tool calls del proceso al cerrarlo: la base del turno siguiente.
  toolCallsTotal: number;
  report: RunTurnReport;
}

/** los límites de turno dentro de un proceso vivo, del lado del daemon. */
export interface TurnHooks {
  onTurnEnd(ended: TurnEnded): void;
  // empieza un turno nuevo en el mismo proceso; `delivered` = los mensajes que lo abren.
  onTurnStart(delivered: string[]): void;
  // mensajes tomados a mitad de un turno (entran en él).
  onDelivered(ids: string[]): void;
}

/** a quién entrega el buzón del run sus órdenes mientras el proceso vive. */
export interface InboxTarget {
  readonly open: boolean;
  command(c: RunInboxCommand): boolean;
}

/** lo que el daemon pone a disposición del driver durante un segmento. */
export interface SegmentIo {
  // prefijo del log del daemon para la plataforma del run (`[runner]` o `[runner:<id>]`).
  readonly log: string;
  readonly feed: EventUploader | null;
  readonly ctx: FeedContext;
  note(text: string): void;
  // el progreso del segmento (fuego y olvido); `workdir` solo en el primer envío de cada proceso.
  progress(toolCalls: number, workdir?: string): void;
  // atiende el buzón del run mientras `target` siga abierto (long-poll); nunca lanza.
  serveInbox(target: InboxTarget, waitMs: number, signal: AbortSignal): void;
  // el log crudo del proceso (--verbose del daemon): su ruta, que se calcula al abrirlo (crea su directorio); null = sin log.
  readonly verboseLog: (() => string) | null;
  // las tool calls con que empezó el turno en curso del proceso (t#636, fase 3).
  toolCallsAt(): number;
  // los límites de turno del daemon; el driver los usa solo si su cli parte turnos en el mismo proceso.
  readonly turns: TurnHooks;
}

/** lo de un segmento que el driver necesita y no sale del claim. */
export interface SegmentSpec {
  readonly claim: ClaimResponse;
  readonly res: MaterializedRun;
  // los servidores mcp de los recursos (t#495, M7), ya preparados.
  readonly resourceMcp: RunMcp;
  readonly lease: RunLease;
  // la plataforma del run y las configuradas, leídas en cada intento (lo privado de las demás se niega).
  readonly platform: { readonly id: string; configured(): string[] };
  // lo que la config del daemon fija por defecto, leído en cada intento (la config se recarga en caliente).
  defaults(): { model: string | undefined; maxBudgetUsd: number | undefined };
}

/** cómo acabó un segmento, ya traducido por el driver. */
export interface SegmentOutcome {
  report: StatusReport;
  // para la auditoría: cómo acabó el intento que cerró el segmento, nunca su salida.
  facts: AttemptFacts;
  toolsByName: Record<string, number>;
  // los slash commands que cargó el segmento, resueltos con el cwd aún en pie (null = el cli no dijo ninguno).
  // `projectCwd` = el cwd cuyos comandos de proyecto cuentan (solo en edición).
  commands(projectCwd: string | null): SlashCommand[] | null;
}

/** lo que el driver dejó preparado para un segmento y retira al cerrarlo. */
export interface PreparedSegment {
  dispose(): void;
}

/** un cli de agente detrás del seam. */
export interface AgentDriver {
  // el backend que sirve (RUNNER_BACKEND del protocolo).
  readonly id: string;
  // el ejecutable (y cómo se le nombra en el log y en los errores del proceso).
  readonly command: string;
  // la versión del cli instalado; null = no está o no se ha detectado.
  readonly version: string | null;
  /** detecta el cli instalado (versión y flags). */
  detect(): Promise<void>;
  /** comprobaciones y cálculos del arranque del daemon; lanza si el driver no puede trabajar. */
  start(): void;
  /** las capabilities que este cli deja anunciar, en el orden del cable. */
  capabilities(facts: HostFacts): string[];
  /** lo de un segmento que vive en disco mientras corre (y que `dispose` borra); lanza si no se puede preparar. */
  prepare(spec: SegmentSpec): PreparedSegment;
  /** lanza el segmento (con los reintentos propios del cli) y lo traduce a su informe; nunca lanza. */
  run(spec: SegmentSpec, prepared: PreparedSegment, io: SegmentIo): Promise<SegmentOutcome>;
}

/** el stdin de un proceso, si el driver lo pidió. */
export type AgentStdin = Writable | null;
