// el vocabulario de una sonda de conformidad (t#440 P6), neutral respecto al cli: qué run se lanza (perfil y política
// toolset_v1, como los manda el server), qué turnos hace el modelo guionizado, qué se comprueba después y qué
// atestaciones evidencia. cada backend escribe sus sondas con sus nombres de tools (claude/claude-probes.ts); el
// proveedor guionizado, el veredicto y el informe solo hablan este vocabulario.
// decisiones:
// - el modelo lo guioniza el arnés: cada rol (el agente principal, un subagente) tiene su lista de llamadas a tools y,
//   tras la última, termina. el rol de una conversación sale de una marca en su primer mensaje (ROLE_MARKER), que es
//   el prompt del run o el que el guion le da al subagente.
// - una comprobación nunca lee lo que dice el modelo: lo que el cli le devuelve al proveedor (el resultado de cada
//   tool, el contexto que le inyecta) y lo que queda en disco. los valores canario son aleatorios por ejecución.
// - controles: lo que tiene que verse para que la medida valga (la tool funciona en ese montaje, la memoria escribió).
//   un control que falla, o un paso del guion que el cli nunca contestó, es un error del arnés, nunca un pass.
// - `gap`: un hueco conocido que se espera abierto hoy (t#651, t#652). su sonda mide igual; filtrar es lo esperado.

import type { BackendAttestation } from '../backends/attestation-evidence.js';
import type { CanaryHome } from './canary-home.js';
import { TOOLSET_SHELL, TOOLSET_V1, type ToolsetV1 } from '../vendor/runner-protocol/index.js';

/** roles de las conversaciones del guion: el agente principal y un subagente que él lanza. */
export const SCRIPT_ROLE = {
  main: 'main',
  sub: 'sub',
} as const;
export type ScriptRole = (typeof SCRIPT_ROLE)[keyof typeof SCRIPT_ROLE];

/** la marca que identifica el rol de una conversación en su primer mensaje. */
export const ROLE_MARKER = (role: ScriptRole): string => `[[conformance:${role}]]`;
export const ROLE_MARKER_RE = /\[\[conformance:([a-z]+)\]\]/;

/** una llamada a tool del modelo guionizado. `input` puede calcularse al contestar (p. ej. una ruta que el run crea). */
export interface ScriptCall {
  tool: string;
  input: Readonly<Record<string, unknown>> | (() => Record<string, unknown>);
}

/** los turnos del modelo por rol: tras la última llamada, termina con texto. */
export type ModelScript = Readonly<Partial<Record<ScriptRole, readonly ScriptCall[]>>>;

/** dónde trabaja el run: el checkout trampa o el scratch de la plataforma (el cwd de un run sin repo). */
export const PROBE_CWD = {
  repo: 'repo',
  scratch: 'scratch',
} as const;
export type ProbeCwd = (typeof PROBE_CWD)[keyof typeof PROBE_CWD];

/** el run de una sonda tal como lo pediría el server: perfil y política neutra (con su autonomía, si la lleva). */
export interface ProbeRun {
  profile: 'read' | 'edit';
  toolset: ToolsetV1;
  cwd: ProbeCwd;
}

// un kit de sonda: sin web, sin recursos ni tools de la plataforma, y lo que diga `t`.
const probeToolset = (t: Pick<ToolsetV1, 'shell' | 'fsWrite' | 'memory' | 'vcsPush'> & Partial<ToolsetV1>): ToolsetV1 => ({
  v: TOOLSET_V1,
  web: false,
  grants: [],
  platformTools: [],
  ...t,
});

/** un run de lectura como lo pide el server: shell de solo lectura, memoria nativa, sin escritura ni push. */
export const readRun = (cwd: ProbeCwd): ProbeRun => ({ profile: 'read', cwd, toolset: probeToolset({ shell: TOOLSET_SHELL.read, fsWrite: false, memory: true, vcsPush: false }) });

/** un run de edición con alguien detrás: shell entera y escritura; `extra` le pone autonomía o subagentes. */
export const editRun = (cwd: ProbeCwd, extra: Pick<ToolsetV1, 'autonomy' | 'subagents'> = {}): ProbeRun => ({
  profile: 'edit',
  cwd,
  toolset: probeToolset({ shell: TOOLSET_SHELL.full, fsWrite: true, memory: true, vcsPush: true, ...extra }),
});

/** lo que tiene que verse para que la medida valga. */
export type ProbeControl =
  // el resultado de ese paso trae el valor (la tool funciona en este montaje).
  | { kind: 'result_has'; role: ScriptRole; step: number; value: string; label: string }
  // el fichero existe y trae el valor.
  | { kind: 'file_has'; path: string; value: string; label: string };

/** una garantía que se comprueba; si no se cumple, el valor canario llegó adonde no debía. */
export type ProbeCheck =
  // el resultado de ese paso no trae el valor.
  | { kind: 'result_lacks'; role: ScriptRole; step: number; value: string; label: string }
  // el valor no llega al proveedor fuera de los turnos del propio modelo (contexto inyectado por el cli).
  | { kind: 'context_lacks'; value: string; label: string }
  // el fichero no existe (un hook, un servidor o un comando no llegó a ejecutarse).
  | { kind: 'file_absent'; path: string; label: string }
  // el fichero no existe o no trae el valor.
  | { kind: 'file_lacks'; path: string; value: string; label: string }
  // el cli no le ofrece al modelo ninguna tool con ese prefijo.
  | { kind: 'tool_not_offered'; prefix: string; label: string };

/** una sonda: el run, el guion, los controles, las comprobaciones y lo que evidencia (ver cabecera). */
export interface Probe {
  id: string;
  // qué garantía mide, en una línea.
  title: string;
  attestations: readonly BackendAttestation[];
  // hueco conocido que se espera abierto (target que lo cierra); null = se espera que la garantía se cumpla.
  gap: string | null;
  // solo en estas plataformas (process.platform); ausente = en todas.
  platforms?: readonly NodeJS.Platform[];
  run: ProbeRun;
  script(c: CanaryHome): ModelScript;
  controls(c: CanaryHome): readonly ProbeControl[];
  checks(c: CanaryHome): readonly ProbeCheck[];
}
