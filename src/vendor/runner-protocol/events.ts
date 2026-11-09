// feed de progreso de un run (agent_run_event, t#378): los tipos de evento que sube el daemon y los topes y
// la cadencia que viajan en el bloque `events` del claim (sin él, el daemon usa sus defaults, que son estos).

// prosa del asistente (text), una línea por tool call (tool: nombre + argumento corto) y notas del
// daemon (system: worktree, fallback de rama…). NUNCA salida de tools ni contenido de ficheros.
export const AGENT_RUN_EVENT_KIND = {
  text: 'text',
  tool: 'tool',
  system: 'system',
  // t#636: un hito de un subagente o de una tarea en segundo plano (task_started, task_progress y task_notification
  // del cli): body = su descripción o su resumen y `task` su id, tipo y estado. solo de un daemon con `subagents`.
  task: 'task',
} as const;
export type AgentRunEventKind = (typeof AGENT_RUN_EVENT_KIND)[keyof typeof AGENT_RUN_EVENT_KIND];

// el árbol de un run con subagentes (t#636): `toolUseId` = el id de la tool call de un evento tool (el que lanza un
// subagente o un workflow es el padre de lo que hagan) y `parentToolUseId` = la tool call de la que cuelga un evento
// hecho DENTRO de un subagente (null = el agente principal). ids opacos del cli, nunca rutas ni texto.
export const AGENT_RUN_EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** qué es una tarea: un subagente, un workflow, un comando en segundo plano u otra cosa que el cli lance. */
export const AGENT_RUN_TASK_TYPE = {
  agent: 'agent',
  workflow: 'workflow',
  shell: 'shell',
  other: 'other',
} as const;
export type AgentRunTaskType = (typeof AGENT_RUN_TASK_TYPE)[keyof typeof AGENT_RUN_TASK_TYPE];

/** estado de una tarea en su último hito: running hasta su task_notification, que trae cómo acabó. */
export const AGENT_RUN_TASK_STATUS = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
} as const;
export type AgentRunTaskStatus = (typeof AGENT_RUN_TASK_STATUS)[keyof typeof AGENT_RUN_TASK_STATUS];

// tope del nombre de una tarea (el de un workflow, `workflow_name` del cli).
export const AGENT_RUN_TASK_NAME_MAX_CHARS = 120;

/** la tarea de un evento kind=task. `toolUseId` del evento = la tool call que la lanzó (si el cli lo dice). */
export interface AgentRunEventTask {
  id: string;
  type: AgentRunTaskType;
  status: AgentRunTaskStatus;
  name?: string;
}
// tope del body de un evento (el server recorta tras enmascarar) y del nombre de la tool.
export const AGENT_RUN_EVENT_BODY_MAX_CHARS = 4000;
// body crudo más largo que esto se rechaza (400) en vez de recortarse: el daemon ya recorta.
export const AGENT_RUN_EVENT_BODY_HARD_MAX_CHARS = 16_000;
export const AGENT_RUN_EVENT_TOOL_MAX_CHARS = 120;
// argumento de una tool call en el feed: una línea, recortada en el daemon (ruta, patrón, comando).
export const AGENT_RUN_EVENT_TOOL_ARG_MAX_CHARS = 200;
// lote que acepta POST /api/runner/runs/:id/events (más → 400).
export const AGENT_RUN_EVENT_BATCH_MAX = 50;
// cadencia de subida del daemon (viaja en el claim): cada FLUSH_MS o al juntar FLUSH_COUNT eventos.
export const AGENT_RUN_EVENT_FLUSH_MS = 1000;
export const AGENT_RUN_EVENT_FLUSH_COUNT = 20;
