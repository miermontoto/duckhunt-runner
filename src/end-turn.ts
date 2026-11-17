// cerrar el turno al responder (t#690, runner-protocol end-turn.ts): tras la tool con la que el agente cierra su turno
// (responder, preguntar, proponer) el modelo escribe siempre un texto final, casi siempre la respuesta otra vez, y la
// conversación no cierra hasta que acaba (mediana 5,4 s, hasta minutos). con el bloque `endTurn` del claim el segmento
// lleva unos settings (--settings, 0600 en el run-config) con un hook PostToolUse sobre esas tools: el propio runner por
// su entrada mínima (end-turn-hook.ts, sin cargar el daemon: corre tras cada respuesta), que lee lo que le pasa el cli por stdin y, si el resultado de la tool lleva RUN_END_TURN_FIELD a true,
// devuelve `{"continue": false}`. el cli cierra el turno al momento con un `result` de éxito (verificado con 2.1.326).
// decisiones:
// - decide el resultado, no el nombre: una respuesta que pide otra llamada no lleva la marca y el agente sigue.
// - el hook nunca falla: sin marca, o con una entrada que no entiende, no escribe nada y sale con 0 (el turno sigue como
//   siempre). PostToolUse solo corre tras una llamada con éxito: una que falla deja al agente reintentar.
// - lo de segundo plano no cambia: el cli despierta al agente al acabar (verificado), y live-session.ts lo sigue igual.
// - los settings de --settings se suman a los del usuario (también con --setting-sources user: verificado), así que un
//   run de lectura los carga igual.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUN_END_TURN_FIELD } from './vendor/runner-protocol/index.js';

// el evento del hook y lo que devuelve para cerrar el turno.
const POST_TOOL_USE = 'PostToolUse';
const STOP_OUTPUT = JSON.stringify({ continue: false, stopReason: 'turno cerrado tras la respuesta' });
// la entrada mínima del hook, junto a este módulo en dist/.
const HOOK_ENTRY = fileURLToPath(new URL('./end-turn-hook.js', import.meta.url));
// lo que hay que escapar en el matcher (una regex del cli) y en una palabra de shell entre comillas simples.
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// un trozo del resultado (un objeto, o el texto json de un bloque) lleva la marca.
const marked = (v: unknown): boolean => {
  if (isRecord(v)) return v[RUN_END_TURN_FIELD] === true || (v.type === 'text' && typeof v.text === 'string' && marked(parseJson(v.text)));
  return Array.isArray(v) ? v.some(marked) : typeof v === 'string' && marked(parseJson(v));
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // no es json (texto suelto de una tool): sin marca.
    return null;
  }
}

/** lo que el hook escribe para la entrada `input` (el json que el cli le pasa por stdin): el cierre si la tool marcó el
 *  final del turno; null = nada (el turno sigue). */
export function endTurnOutput(input: string): string | null {
  const ev = parseJson(input);
  if (!isRecord(ev) || ev.hook_event_name !== POST_TOOL_USE) return null;
  // el cli da el resultado de una tool mcp como sus bloques de contenido (o su texto, según la versión).
  return marked(ev.tool_response) ? STOP_OUTPUT : null;
}

/** los settings del segmento con el hook sobre `tools` (nombres completos del cli). */
export function endTurnSettings(tools: readonly string[]): object {
  const matcher = `^(${tools.map((t) => t.replace(REGEX_SPECIAL, '\\$&')).join('|')})$`;
  const command = [process.execPath, HOOK_ENTRY].map(shellQuote).join(' ');
  return { hooks: { [POST_TOOL_USE]: [{ matcher, hooks: [{ type: 'command', command }] }] } };
}

/** el hook (end-turn-hook.ts): lee su entrada por stdin y escribe el cierre si toca. nunca falla. */
export function endTurnHookCommand(): void {
  try {
    const out = endTurnOutput(fs.readFileSync(0, 'utf8'));
    if (out !== null) process.stdout.write(out);
  } catch {
    // sin stdin legible no hay nada que cerrar: el turno sigue como siempre.
  }
}
