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
// fase 3 (RUNNER_CAPABILITY.liveTurns, `live.turns`): hablar con el run mientras corre.
// - un mensaje de la persona viaja como orden `message`: el daemon lo escribe en stdin como mensaje de usuario con su id
//   de uuid y el cli lo devuelve (--replay-user-messages) al tomarlo: ESE es el acuse. el cli lo toma en el siguiente
//   límite de tool del turno en curso (entra en ese turno: un solo `result`) o al momento si el agente está parado.
// - el mensaje sigue en pending_input del server hasta el acuse: si el proceso muere antes, lo entrega el siguiente claim.
// - cada `result` cierra un turno: cuando empieza el siguiente en el mismo proceso (un mensaje tomado con el agente parado,
//   o el cli que lo despierta al acabar lo de fondo), el daemon lo dice con POST …/turn (RunTurnBody): el server cierra el
//   segmento con el informe de ese turno y abre el siguiente, marcado como continuación del proceso. un mensaje tomado a
//   mitad de turno se acusa con POST …/delivered. el coste, el diff y la vuelta atrás siguen siendo por segmento.

export const RUN_INBOX_KIND = {
  stopTask: 'stop_task',
  message: 'message',
} as const;
export type RunInboxKind = (typeof RUN_INBOX_KIND)[keyof typeof RUN_INBOX_KIND];

/** una orden del buzón: parar una tarea (su id es el request_id del control_request) o un mensaje de la persona (su id es
 *  el uuid con el que viaja en stdin y con el que el cli lo devuelve al tomarlo). */
export type RunInboxCommand =
  | { id: string; kind: typeof RUN_INBOX_KIND.stopTask; taskId: string }
  | { id: string; kind: typeof RUN_INBOX_KIND.message; text: string };

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
  // fase 3: solo a un daemon con RUNNER_CAPABILITY.liveTurns. el buzón trae mensajes y el proceso parte sus turnos.
  turns?: true;
}

/** lo que el daemon cuenta de un turno al cerrarlo dentro del proceso (los campos del status de un segmento). */
export interface RunTurnReport {
  // el total de la sesión hasta ese `result` (como en el status: el server pone la base).
  costUsd?: number;
  numTurns?: number;
  // las tool calls de ESE turno.
  toolCalls?: number;
  sessionId?: string;
  model?: string;
  result?: string;
  lastMessageUuid?: string;
  startTree?: string;
  startHead?: string;
  extraStarts?: Array<{ repo: string; tree: string; head: string }>;
}

/** POST /api/runner/runs/:id/turn: cierra `segment` con su informe y abre el siguiente en el mismo proceso. `delivered` = los
 *  mensajes que el turno nuevo tomó al empezar. responde { segment } (el nuevo). */
export interface RunTurnBody {
  segment: number;
  report: RunTurnReport;
  delivered: string[];
}

/** POST /api/runner/runs/:id/delivered: mensajes tomados a mitad de un turno (entran en él). */
export interface RunDeliveredBody {
  segment: number;
  ids: string[];
}
