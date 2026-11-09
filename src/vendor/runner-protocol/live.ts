// el buzón de un run vivo (t#636, fase 2): lo que la persona manda a un proceso de claude que sigue corriendo. un daemon
// con RUNNER_CAPABILITY.liveInput recibe en el claim el bloque `live`: lanza claude con stdin en stream-json (el prompt va
// como primer mensaje), lo mantiene abierto mientras queden tareas en segundo plano y pide el buzón con un long-poll
// (GET /api/runner/runs/:id/inbox?segment=&wait=) mientras el proceso vive.
// decisiones:
// - el buzón vive en memoria del server y por segmento: un reinicio del server pierde lo que no se entregó (parar una
//   tarea se vuelve a pulsar) y un segmento nuevo nunca recibe órdenes de otro proceso.
// - entregar es sacar del buzón: no hay acuse. si el proceso ya no puede atenderla (stdin cerrado, la tarea ya acabó),
//   el hilo lo dice solo: la tarea sigue su estado (los eventos task).
// - stop_task = el control_request {subtype: 'stop_task', task_id} del cli (verificado con el 2.1.319: la tarea se para
//   al instante y el agente principal se entera).

export const RUN_INBOX_KIND = {
  stopTask: 'stop_task',
} as const;
export type RunInboxKind = (typeof RUN_INBOX_KIND)[keyof typeof RUN_INBOX_KIND];

/** una orden del buzón: su id (también el request_id del control_request) y la tarea que parar. */
export interface RunInboxCommand {
  id: string;
  kind: typeof RUN_INBOX_KIND.stopTask;
  taskId: string;
}

/** respuesta de GET …/inbox: las órdenes pendientes (vacía si venció la espera sin ninguna). */
export interface RunInboxResponse {
  commands: RunInboxCommand[];
}

// cuánto retiene el server un GET del buzón sin órdenes (el daemon vuelve a pedirlo al volver vacío).
export const RUN_INBOX_WAIT_MS = 25_000;
// órdenes por respuesta.
export const RUN_INBOX_COMMANDS_MAX = 20;

/** bloque `live` del claim: solo a un daemon con RUNNER_CAPABILITY.liveInput. */
export interface LegacyClaimLive {
  // espera del long-poll que el daemon pide (≤ RUN_INBOX_WAIT_MS).
  waitMs: number;
}
