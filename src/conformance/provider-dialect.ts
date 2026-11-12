// el contrato entre el proveedor guionizado y un dialecto de api de modelo (t#440 P6). el servidor http
// (scripted-provider.ts) recibe y graba; el dialecto decide qué contestar según el guion y, al final, traduce lo grabado
// a observaciones neutrales (resultados de tool por paso, tools ofrecidas, contexto inyectado). claude code habla la
// Messages api de anthropic (anthropic-dialect.ts); codex (P7) traerá la Responses api de openai detrás del mismo
// contrato.
// decisiones:
// - el id de cada llamada a tool lleva su rol y su paso: el resultado que el cli devuelve se casa con el paso del guion
//   sin estado en el servidor (un reintento del cli pide el mismo turno y recibe la misma llamada).
// - el turno de una conversación es cuántos turnos del modelo trae ya su historial: el servidor no guarda nada por
//   conversación.

import type { ModelScript, ScriptRole } from './probe.js';

/** una petición que recibió el proveedor, tal cual (cabeceras sin credenciales). */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  // la contestó el dialecto o el stub de la plataforma (false = ruta sin guion: 404).
  handled: boolean;
}

/** lo que se contesta: un json (también los errores), un stream de eventos sse o solo un estado. */
export type ProviderReply =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'sse'; events: readonly { event: string; data: unknown }[] }
  | { kind: 'empty'; status: number };

/** el resultado de una llamada del guion tal como el cli se lo devolvió al proveedor. */
export interface ObservedToolResult {
  role: ScriptRole;
  step: number;
  text: string;
  isError: boolean;
}

/** lo que el cli le contó al proveedor durante la sonda (ver cabecera), sin un solo turno del propio modelo. */
export interface ProviderObservation {
  // roles de las conversaciones que llegaron al proveedor con tools (las que siguen el guion).
  roles: ScriptRole[];
  // el primer resultado de cada paso contestado.
  results: ObservedToolResult[];
  // las tools que el cli le ofreció al modelo en algún momento.
  offeredTools: string[];
  // todo lo que el cli mandó salvo los turnos del modelo: system, mensajes del usuario y resultados de tools.
  context: string;
}

/** un dialecto de api de modelo (ver cabecera). */
export interface ProviderDialect {
  readonly id: string;
  /** contesta una petición de su api según el guion; null = la ruta no es suya. */
  answer(method: string, path: string, body: string, script: ModelScript): ProviderReply | null;
  /** traduce lo grabado a observaciones neutrales. */
  observe(requests: readonly RecordedRequest[]): ProviderObservation;
}

/** el id de una llamada del guion con su rol y su paso, y cómo leerlos de vuelta. */
export const scriptCallId = (prefix: string, role: ScriptRole, step: number, nonce: string): string => `${prefix}cf_${role}_${step}_${nonce}`;
export const SCRIPT_CALL_ID_RE = /cf_([a-z]+)_(\d+)_[0-9a-f]+$/;
