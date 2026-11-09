// sesión viva de claude con stdin en stream-json (t#636, fase 2; el cable en runner-protocol live.ts): el prompt va como
// primer mensaje y stdin sigue abierto mientras el proceso pueda necesitarlo, para las órdenes del buzón (parar una
// tarea = el control_request stop_task del cli).
// decisiones:
// - con stdin abierto el cli no sale tras su `result`: lo cierra esta clase. al llegar un `result` del agente principal sin
//   tareas en marcha (las cuenta con task_started / task_notification), o uno con error. con tareas en segundo plano lo
//   deja abierto: al acabar, el cli despierta al agente principal (otro turno con su `result`) y entonces se cierra.
// - si la última tarea acaba con el agente ya parado y no despierta en LIVE_WAKE_GRACE_MS, se cierra igual; y sin ningún
//   evento en LIVE_SILENCE_MAX_MS con el agente parado (una tarea que nunca avisa), también: nada retiene el segmento
//   más allá de eso salvo el timeout de siempre.
// - las escrituras a un stdin ya cerrado (el proceso salió) se descartan: el error del pipe no tumba el daemon.
// fase 3 (hablar mientras corre): un mensaje de la persona se escribe con su id como uuid y el cli lo devuelve al tomarlo
// (--replay-user-messages): ese es el acuse. tomado con el agente parado (tras un `result`) abre un turno nuevo
// (onTurnStart con sus ids); tomado a mitad de un turno entra en él (onDelivered). el cli despierta solo al acabar algo en
// segundo plano: también es un turno nuevo, sin mensajes. un mensaje escrito y aún sin acuse retiene stdin abierto igual
// que una tarea: el cli lo tomará tras su `result`.

import type { Writable } from 'node:stream';
import type { StreamLine } from './claude.js';
import { RUN_INBOX_KIND, type RunInboxCommand } from './vendor/runner-protocol/index.js';

// cuánto espera a que el agente principal despierte tras acabar su última tarea en segundo plano.
export const LIVE_WAKE_GRACE_MS = 60_000;
// silencio máximo del proceso con el agente principal parado y tareas que no avisan.
export const LIVE_SILENCE_MAX_MS = 15 * 60_000;

export interface LiveTimers {
  wakeGraceMs: number;
  silenceMaxMs: number;
}

/** lo que el daemon hace en cada límite de turno dentro del proceso (fase 3). */
export interface LiveTurnHooks {
  // el agente principal cerró un turno con este `result`.
  onTurnEnd(ev: StreamLine): void;
  // empieza un turno nuevo en el mismo proceso; `delivered` = los mensajes que lo abren (ninguno si lo despertó el cli).
  onTurnStart(delivered: string[]): void;
  // mensajes tomados a mitad de un turno (entran en él).
  onDelivered(ids: string[]): void;
}

const DEFAULT_TIMERS: LiveTimers = { wakeGraceMs: LIVE_WAKE_GRACE_MS, silenceMaxMs: LIVE_SILENCE_MAX_MS };

/** un mensaje de usuario del stream-json de entrada del cli. */
export const userMessageLine = (text: string): string => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

const isMain = (ev: StreamLine): boolean => ev.parent_tool_use_id === undefined || ev.parent_tool_use_id === null;

/** el stdin de un proceso de claude vivo (ver cabecera). */
export class LiveSession {
  private readonly running = new Set<string>();
  // mensajes de la persona escritos en stdin y aún sin acuse (fase 3).
  private readonly awaiting = new Set<string>();
  // hubo un `result` y el turno siguiente aún no empezó: el próximo que empiece parte el segmento.
  private turnClosed = false;
  // el agente principal acabó su turno (último `result`) y no ha vuelto a hablar.
  private idle = false;
  private ended = false;
  private wakeTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly stdin: Writable,
    private readonly timers: LiveTimers = DEFAULT_TIMERS,
    private readonly hooks: LiveTurnHooks | null = null,
  ) {
    stdin.on('error', () => {
      // EPIPE: el proceso ya cerró su stdin; lo que quedaba por escribir ya no tiene a quién.
      this.ended = true;
    });
  }

  /** ¿sigue abierto stdin? */
  get open(): boolean {
    return !this.ended;
  }

  /** tareas en marcha según el stream (ids del cli). */
  get tasks(): ReadonlySet<string> {
    return this.running;
  }

  /** el prompt del segmento como primer mensaje. */
  start(prompt: string): void {
    this.write(userMessageLine(prompt));
  }

  /** cada evento del stream: lleva la cuenta de tareas y cierra stdin cuando ya no queda nada que esperar. */
  observe(ev: StreamLine): void {
    if (this.ended) return;
    if (ev.type === 'system' && typeof ev.task_id === 'string') {
      if (ev.subtype === 'task_started') this.running.add(ev.task_id);
      if (ev.subtype === 'task_notification') this.running.delete(ev.task_id);
    }
    // el acuse de un mensaje de la persona (fase 3): abre turno si el agente estaba parado; si no, entra en el suyo.
    if (ev.type === 'user' && ev.isReplay === true && typeof ev.uuid === 'string' && this.awaiting.delete(ev.uuid)) {
      if (this.idle) this.startTurn([ev.uuid]);
      else this.hooks?.onDelivered([ev.uuid]);
    }
    // el agente principal vuelve a hablar tras un `result` sin mensaje que lo abra: lo despertó el cli.
    if (ev.type === 'assistant' && isMain(ev) && this.idle) this.startTurn([]);
    if (ev.type === 'result') {
      this.idle = true;
      this.turnClosed = true;
      this.hooks?.onTurnEnd(ev);
      if ((this.running.size === 0 && this.awaiting.size === 0) || ev.is_error === true) {
        this.end();
        return;
      }
    }
    if (this.idle) this.armWhileIdle();
  }

  /** una orden del buzón. false si stdin ya está cerrado (nadie la atenderá) o es un mensaje sin hooks de turno. */
  command(cmd: RunInboxCommand): boolean {
    if (this.ended) return false;
    if (cmd.kind === RUN_INBOX_KIND.stopTask) {
      this.write(`${JSON.stringify({ type: 'control_request', request_id: cmd.id, request: { subtype: 'stop_task', task_id: cmd.taskId } })}\n`);
      return true;
    }
    if (this.hooks === null) return false;
    this.awaiting.add(cmd.id);
    // un mensaje retiene stdin abierto hasta su acuse: ni la gracia ni el silencio lo cierran mientras tanto.
    this.clear();
    this.write(`${JSON.stringify({ type: 'user', uuid: cmd.id, message: { role: 'user', content: cmd.text } })}\n`);
    return true;
  }

  // un turno nuevo dentro del proceso (fase 3): el agente deja de estar parado y, si el anterior cerró, parte el segmento.
  private startTurn(delivered: string[]): void {
    this.idle = false;
    this.clear();
    if (!this.turnClosed) return;
    this.turnClosed = false;
    this.hooks?.onTurnStart(delivered);
  }

  /** cierra stdin: el cli acaba y sale. idempotente. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.clear();
    this.stdin.end();
  }

  // con el agente parado: sin tareas, la gracia para despertar; con ellas, el tope de silencio (cada evento lo rearma). un
  // mensaje sin acuse lo retiene: el cli lo tomará.
  private armWhileIdle(): void {
    this.clear();
    if (this.awaiting.size > 0) return;
    if (this.running.size === 0) this.wakeTimer = setTimeout(() => this.end(), this.timers.wakeGraceMs);
    else this.silenceTimer = setTimeout(() => this.end(), this.timers.silenceMaxMs);
  }

  private clear(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.wakeTimer = null;
    this.silenceTimer = null;
  }

  private write(line: string): void {
    if (this.ended) return;
    this.stdin.write(line);
  }
}
