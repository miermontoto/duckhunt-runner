// autonomía de una conversación en edición (t#527): los permission modes de claude code en tres niveles y el cable de
// las peticiones de permiso que el daemon reenvía a la plataforma mientras el run espera a la persona.
// decisiones:
// - solo conversaciones en edición con alguien detrás. lectura, investigaciones y prompts de reglas llevan el kit fijo
//   de siempre (dontAsk); null = ese kit fijo, también en las conversaciones en edición anteriores a t#527.
// - manual = `default` del cli: lee sin preguntar (Read/Grep/Glob, la shell de solo lectura que el cli auto-aprueba y
//   el mcp de la plataforma) y todo lo demás lo pregunta por `--permission-prompt-tool`. auto = `auto`: el
//   clasificador del cli decide y, tras sus paradas seguidas, vuelve a preguntar por la misma tool. bypass =
//   `bypassPermissions`: no pregunta nada y el deny sigue mandando (verificado con el cli 2.1.309).
// - la tool de permisos la sirve el daemon (un servidor stdio suyo, AGENT_PERMISSION_TOOL), no el mcp de la
//   plataforma: el cli la esconde del modelo, su llamada puede esperar minutos (el cli 2.1.309 esperó 75 s sin
//   cortar) y el daemon sondea a la plataforma con peticiones cortas (PERMISSION_WAIT_MAX_MS) para no cruzar el corte
//   del proxy. se autentica con el token per-run del claim (audiencia del mcp, ligado al run).
// - la petición viaja recortada (lo que ve la persona); el daemon guarda la entrada original y la devuelve tal cual en
//   `updatedInput` al permitir: la plataforma nunca reescribe lo que ejecuta el cli.
// - nadie responde en `ttlMs` (AGENT_PERMISSION_TTL_MS) = denegado; el run sigue y lo cuenta.
// - aprobar «siempre aquí» guarda una regla del cli en la conversación (`approvals` de toolset_v1, ids de
//   --allowedTools): desde el siguiente segmento va en el allow y, en el que corre, la plataforma responde sola a lo
//   que casa con ella.

/** nivel de autonomía de una conversación en edición, de menos a más. */
export const AGENT_AUTONOMY = {
  manual: 'manual',
  auto: 'auto',
  bypass: 'bypass',
} as const;
export type AgentAutonomy = (typeof AGENT_AUTONOMY)[keyof typeof AGENT_AUTONOMY];

/** los niveles en su orden (subir = más a la derecha). */
export const AGENT_AUTONOMY_LEVELS: readonly AgentAutonomy[] = [AGENT_AUTONOMY.manual, AGENT_AUTONOMY.auto, AGENT_AUTONOMY.bypass];

/** el permission mode del cli de claude de cada nivel (el kit fijo es dontAsk, HARNESS_PERMISSION_MODE). */
export const AGENT_AUTONOMY_PERMISSION_MODE: Readonly<Record<AgentAutonomy, string>> = {
  [AGENT_AUTONOMY.manual]: 'default',
  [AGENT_AUTONOMY.auto]: 'auto',
  [AGENT_AUTONOMY.bypass]: 'bypassPermissions',
};

/** ¿el nivel puede preguntar a la persona? (lleva la tool de permisos). */
export const autonomyAsks = (level: AgentAutonomy): boolean => level !== AGENT_AUTONOMY.bypass;

/** la tool de permisos que sirve el daemon: su servidor stdio en el mcp-config del run y su nombre. */
export const AGENT_PERMISSION_TOOL = {
  server: 'duckhunt-runner-permission',
  tool: 'prompt',
} as const;
/** el id que recibe `--permission-prompt-tool`. */
export const AGENT_PERMISSION_TOOL_ID = `mcp__${AGENT_PERMISSION_TOOL.server}__${AGENT_PERMISSION_TOOL.tool}`;

/** ruta de las peticiones de permiso en la plataforma (token per-run). */
export const RUNNER_PERMISSIONS_PATH = '/api/runner-permissions';
/** tras este tiempo sin respuesta, la petición queda denegada. */
export const AGENT_PERMISSION_TTL_MS = 30 * 60_000;
/** cuánto aguanta como mucho una consulta de estado antes de responder «pendiente» (por debajo del corte del proxy). */
export const PERMISSION_WAIT_MAX_MS = 25_000;
/** la entrada de la tool tal como viaja a la plataforma (json): más larga, el daemon la recorta y lo marca. */
export const PERMISSION_INPUT_MAX_CHARS = 16_000;
/** largo del nombre de la tool por la que se pregunta. */
export const PERMISSION_TOOL_NAME_MAX_CHARS = 200;
/** largo del id de tool_use del cli. */
export const PERMISSION_TOOL_USE_ID_MAX_CHARS = 200;
/** largo del motivo de una denegación que vuelve al agente. */
export const PERMISSION_MESSAGE_MAX_CHARS = 2_000;
/** reglas «siempre aquí» de una conversación (approvals) y largo de cada una. */
export const AGENT_PERMISSION_APPROVALS_MAX = 50;
export const AGENT_PERMISSION_APPROVAL_MAX_CHARS = 300;

/** la decisión de una petición (null en el cable = sigue pendiente). */
export const PERMISSION_DECISION = {
  allow: 'allow',
  deny: 'deny',
} as const;
export type PermissionDecision = (typeof PERMISSION_DECISION)[keyof typeof PERMISSION_DECISION];

/** el bloque `permissions` del claim: dónde preguntar y cuánto esperar (solo a un daemon con `autonomy` y un nivel que pregunta). */
export interface LegacyClaimPermissions {
  url: string;
  ttlMs: number;
  waitMs: number;
}

/** lo que el daemon manda al pedir permiso (POST a la ruta, token per-run). */
export interface PermissionPromptRequest {
  segment: number;
  toolName: string;
  // la entrada de la tool, recortada si pasa de PERMISSION_INPUT_MAX_CHARS (`truncated`).
  input: Record<string, unknown>;
  truncated: boolean;
  toolUseId: string | null;
}

/** el estado de una petición (respuesta del POST y del GET /:id?wait=ms). */
export interface PermissionPromptStatus {
  id: number;
  decision: PermissionDecision | null;
  // el motivo para el agente al denegar (de la persona, o el de la caducidad).
  message: string | null;
}
