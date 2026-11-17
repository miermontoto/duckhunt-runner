// cerrar el turno del agente al responder (t#690): tras la tool que cierra un turno (responder, preguntar, proponer) el
// modelo escribe siempre un texto final, casi siempre la respuesta otra vez (r#585: 243 turnos medidos, mediana 5,4 s y
// hasta 218 s), y la conversación no cierra hasta que acaba. ni el prompt ni la instrucción del resultado lo evitan.
// un daemon con RUNNER_CAPABILITY.endTurn recibe en el claim el bloque `endTurn` con esas tools (sus nombres completos
// en el cli) y les pone un hook PostToolUse que devuelve `{"continue": false}` cuando el resultado de la tool lleva
// RUN_END_TURN_FIELD a true: el cli cierra el turno al momento, con un `result` de éxito y la sesión intacta.
// decisiones:
// - quien decide si el turno acaba es el resultado de la tool, no su nombre: una respuesta que pide otra llamada (el
//   veredicto que falta de un watcher) no lleva la marca y el agente sigue.
// - solo una llamada con éxito dispara el hook (PostToolUse): una que falla la validación deja al agente reintentar.
// - lo de segundo plano sigue igual: el cli despierta al agente al acabar (verificado con 2.1.326).
// - sin la capability no viaja la clave: el turno acaba cuando el modelo para, como siempre.

/** la clave del resultado (json) de una tool que dice que el turno del agente acaba con ella. */
export const RUN_END_TURN_FIELD = 'endTurn';

/** el bloque `endTurn` del claim: las tools (nombre completo en el cli, `mcp__<server>__<tool>`) que pueden cerrar el turno. */
export interface LegacyClaimEndTurn {
  tools: string[];
}
