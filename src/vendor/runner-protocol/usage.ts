// uso de contexto de un run (t#682): cuánto ocupa la ventana de contexto del hilo principal del agente en su última
// llamada al modelo. viaja opcional en todo lo que informa de un segmento: el status (legacy) y el result (v0, dentro
// de `usage`), el informe de un turno del proceso vivo (live.ts) y, para un medidor en vivo, el progreso (legacy) y
// el lease (v0). sin capability: el server descarta lo que no conoce (z.object) y un server anterior también.
// decisiones:
// - de dónde sale (verificado en r#565 con claude 2.1.326, codex 0.162.1 y opencode 2.0.29), cada driver con lo suyo:
//   claude = el `message.usage` del último `assistant` con `parent_tool_use_id` null (input + cache_read +
//   cache_creation + output) y la ventana de `result.modelUsage[modelo].contextWindow`; codex = `thread/tokenUsage/
//   updated` (`last.totalTokens`, `modelContextWindow`); opencode acp = `usage_update` (`used`, `size`).
// - nunca del `result.usage` de claude ni de los tokens de `modelUsage`: suman todas las llamadas de la sesión.
// - `windowTokens` null = el backend no la dijo (nunca 0, nunca una ventana inventada): la web enseña solo los tokens.
// - números crudos: el porcentaje lo calcula quien lo pinta (el de la tui de codex resta una base fija).
// - `compactions` cuenta lo visto en el TRAMO que cubre el informe, como `toolCalls`: el segmento en el status y el
//   result, el turno en el informe de turno, lo que va de segmento en el progreso y el lease. un proceso no ve las
//   compactaciones de los anteriores, así que el total de la conversación lo suma el server. ausente = ninguna.
// - se valida por presencia: un `context` sin forma se descarta entero (nunca un 400 que deje el segmento sin cerrar).

/** tope de tokens que se acepta en `usedTokens` y `windowTokens` (holgado: solo acota lo guardado). */
export const RUN_CONTEXT_TOKENS_MAX = 100_000_000;
/** tope de compactaciones por informe. */
export const RUN_CONTEXT_COMPACTIONS_MAX = 10_000;

/** cuánto ocupa el contexto del hilo principal en su última llamada al modelo. */
export interface RunContextUsage {
  // entero ≥ 0.
  usedTokens: number;
  // entero > 0; null = el backend no la dijo.
  windowTokens: number | null;
  // las del tramo que cubre el informe (ver cabecera); ausente = ninguna.
  compactions?: number;
}

/** lo que añade un daemon al status, al informe de un turno y al progreso de un segmento (todo opcional). */
export interface RunContextFields {
  context?: RunContextUsage;
}
