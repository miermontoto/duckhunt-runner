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

const DEFAULT_TIMERS: LiveTimers = { wakeGraceMs: LIVE_WAKE_GRACE_MS, silenceMaxMs: LIVE_SILENCE_MAX_MS };

/** un mensaje de usuario del stream-json de entrada del cli. */
export const userMessageLine = (text: string): string => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

const isMain = (ev: StreamLine): boolean => ev.parent_tool_use_id === undefined || ev.parent_tool_use_id === null;

/** el stdin de un proceso de claude vivo (ver cabecera). */
export class LiveSession {
  private readonly running = new Set<string>();
  // el agente principal acabó su turno (último `result`) y no ha vuelto a hablar.
  private idle = false;
  private ended = false;
  private wakeTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly stdin: Writable,
    private readonly timers: LiveTimers = DEFAULT_TIMERS,
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
    if (ev.type === 'assistant' && isMain(ev)) {
      this.idle = false;
      this.clear();
    }
    if (ev.type === 'result') {
      this.idle = true;
      if (this.running.size === 0 || ev.is_error === true) {
        this.end();
        return;
      }
    }
    if (this.idle) this.armWhileIdle();
  }

  /** una orden del buzón. false si stdin ya está cerrado (nadie la atenderá). */
  command(cmd: RunInboxCommand): boolean {
    if (this.ended || cmd.kind !== RUN_INBOX_KIND.stopTask) return false;
    this.write(`${JSON.stringify({ type: 'control_request', request_id: cmd.id, request: { subtype: 'stop_task', task_id: cmd.taskId } })}\n`);
    return true;
  }

  /** cierra stdin: el cli acaba y sale. idempotente. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.clear();
    this.stdin.end();
  }

  // con el agente parado: sin tareas, la gracia para despertar; con ellas, el tope de silencio (cada evento lo rearma).
  private armWhileIdle(): void {
    this.clear();
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
