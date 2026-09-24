// subida en lotes del feed de progreso de un run (POST /api/runner/runs/:id/events, t#378). numera
// cada evento con un seq monotónico que arranca en el `events.nextSeq` del claim (el server lo
// calcula sobre lo ya guardado, así segmentos y reintentos nunca pisan un seq). cadencia del claim:
// cada flushMs o al juntar flushCount. reintento ACOTADO: un lote que falla por red/5xx/429 se
// reintenta en los ticks siguientes hasta EVENT_BATCH_MAX_ATTEMPTS y luego se descarta (el feed es
// informativo; nunca debe retener el cierre del run). 404/409 = el run ya no acepta eventos: se
// para. el daemon llama a close() ANTES de reportar el status (el server rechaza eventos de un run
// cerrado).

import type { EventsConfig } from './claim.js';
import type { FeedEvent } from './feed.js';

export interface SeqEvent extends FeedEvent {
  seq: number;
}

// envía un lote y devuelve el status http. lanza en error de red o timeout.
export type EventPoster = (events: SeqEvent[]) => Promise<number>;

// intentos de un mismo lote (fallos transitorios seguidos) antes de descartarlo.
const EVENT_BATCH_MAX_ATTEMPTS = 3;
// cola máxima en memoria: con el server caído el feed no crece sin fin (lo nuevo se descarta).
const EVENT_QUEUE_MAX = 1000;
// pausa entre reintentos al vaciar la cola en close().
const EVENT_CLOSE_RETRY_MS = 1000;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

// sent = aceptado; retry = fallo transitorio, sigue en cola; rejected = 4xx, lote descartado;
// gave_up = transitorio agotado, lote descartado; stopped = el run ya no acepta eventos.
type Outcome = 'idle' | 'sent' | 'retry' | 'rejected' | 'gave_up' | 'stopped';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class EventUploader {
  private queue: SeqEvent[] = [];
  private seq: number;
  private failures = 0;
  private dropped = 0;
  private stopped = false;
  private closing = false;
  private inflight: Promise<Outcome> | null = null;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly post: EventPoster,
    private readonly cfg: EventsConfig,
    // prefijo de log (`run 88`).
    private readonly label: string,
  ) {
    this.seq = cfg.nextSeq;
    this.timer = setInterval(() => {
      if (this.queue.length > 0) void this.flush();
    }, cfg.flushMs);
    this.timer.unref();
  }

  /** encola un evento con el siguiente seq; dispara la subida al juntar flushCount. */
  push(event: FeedEvent): void {
    if (this.stopped || this.closing) return;
    if (this.queue.length >= EVENT_QUEUE_MAX) {
      this.dropped++;
      return;
    }
    this.queue.push({ ...event, seq: this.seq++ });
    if (this.queue.length >= this.cfg.flushCount) void this.flush();
  }

  /** sube el siguiente lote (uno a la vez); devuelve el resultado de ese lote. */
  flush(): Promise<Outcome> {
    if (this.inflight) return this.inflight;
    if (this.stopped || this.queue.length === 0) return Promise.resolve('idle');
    this.inflight = this.sendBatch().then((outcome) => {
      this.inflight = null;
      // tras un envío bueno, si ya hay otro lote lleno no espera al tick.
      if (outcome === 'sent' && !this.closing && this.queue.length >= this.cfg.flushCount) void this.flush();
      return outcome;
    });
    return this.inflight;
  }

  /** para el timer y vacía la cola con reintento acotado. nunca lanza. */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    // i/o secuencial: un lote tras otro, en orden de seq.
    for (;;) {
      const outcome = await (this.inflight ?? this.flush());
      if (this.stopped || this.queue.length === 0) break;
      if (outcome === 'gave_up') {
        // el server no responde: el resto correría la misma suerte y retrasaría el status.
        this.dropped += this.queue.length;
        this.queue = [];
        break;
      }
      if (outcome === 'retry') await sleep(EVENT_CLOSE_RETRY_MS);
    }
    if (this.dropped > 0) console.error(`[runner] ${this.label}: ${this.dropped} eventos del feed descartados`);
  }

  private settle(count: number, delivered: boolean): void {
    this.queue.splice(0, count);
    this.failures = 0;
    if (!delivered) this.dropped += count;
  }

  private async sendBatch(): Promise<Outcome> {
    const batch = this.queue.slice(0, this.cfg.batchMax);
    const status = await this.post(batch).catch((err: Error) => {
      console.error(`[runner] ${this.label}: subida del feed falló: ${err.message}`);
      return null;
    });
    if (status !== null && status >= 200 && status < 300) {
      this.settle(batch.length, true);
      return 'sent';
    }
    if (status === HTTP_NOT_FOUND || status === HTTP_CONFLICT) {
      // run cerrado o desconocido: nada de lo que quede en cola llegará ya.
      this.stopped = true;
      this.dropped += this.queue.length;
      this.queue = [];
      return 'stopped';
    }
    const transient = status === null || status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR;
    if (transient && ++this.failures < EVENT_BATCH_MAX_ATTEMPTS) return 'retry';
    console.error(`[runner] ${this.label}: lote del feed descartado (${status === null ? 'sin respuesta' : `http ${status}`})`);
    this.settle(batch.length, false);
    return transient ? 'gave_up' : 'rejected';
  }
}
