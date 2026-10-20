// feed de progreso de un run (agent_run_event, t#378): los tipos de evento que sube el daemon y los topes y
// la cadencia que viajan en el bloque `events` del claim (sin él, el daemon usa sus defaults, que son estos).

// prosa del asistente (text), una línea por tool call (tool: nombre + argumento corto) y notas del
// daemon (system: worktree, fallback de rama…). NUNCA salida de tools ni contenido de ficheros.
export const AGENT_RUN_EVENT_KIND = {
  text: 'text',
  tool: 'tool',
  system: 'system',
} as const;
export type AgentRunEventKind = (typeof AGENT_RUN_EVENT_KIND)[keyof typeof AGENT_RUN_EVENT_KIND];
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
