// recursos de la máquina en el cable (t#495, M7): lo que un daemon anuncia que puede poner a disposición de un run
// (hoy la identidad aws por defecto y las sesiones de navegador guardadas por odysea) y su salud, sin paths.
// decisiones:
// - la misma forma en los dos cables: `resources: [{type, keys}]` y `health: [{type, key, kind}]` (v0.ts los lleva
//   en ClaimRequestV0; el legacy, en el cuerpo del claim, LegacyClaimResources). el legacy solo los manda un daemon
//   con sesiones de navegador expuestas a la plataforma: sin ellas, el cable de siempre.
// - son datos de presencia: lo que pasa de los topes se recorta y lo que no tiene forma se descarta, nunca tumba el
//   claim (como los repos).
// - una sesión de navegador solo se concede a un run si la máquina anuncia la capability `browser` (odysea >= la
//   mínima que el daemon sabe usar) Y su clave; el acceso es el del grant (toolset.ts::GRANT_ACCESS): read navega y
//   lee, interact además hace clic y teclea, full además evalúa js y ve las cabeceras de red (cookies incluidas).

/** clave de una sesión de navegador: corta para que `mcp__res_browser_<clave>__<tool>` quepa en el tope de nombre de
 *  tool del api. */
export const BROWSER_KEY_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;

/** salud de un recurso anunciado (la de las sesiones de navegador del daemon). un código que el server no conoce se
 *  enseña tal cual (daemon más nuevo). */
export const RESOURCE_HEALTH_KIND = {
  // sin sesión guardada en el vault.
  missing: 'missing',
  // la sesión guardada no se puede leer.
  invalid: 'invalid',
  // todas sus cookies de la allowlist caducaron.
  expired: 'expired',
  // el probe de la sesión acaba en el login.
  loggedOut: 'logged_out',
  // sin odysea (o una versión que el daemon no sabe usar).
  toolMissing: 'tool_missing',
  // el probe no pudo comprobarla (no bloquea).
  unverifiable: 'unverifiable',
} as const;
export type ResourceHealthKind = (typeof RESOURCE_HEALTH_KIND)[keyof typeof RESOURCE_HEALTH_KIND];

/** las que impiden usar el recurso en un run. */
export const BLOCKING_RESOURCE_HEALTH: ReadonlySet<string> = new Set<string>([
  RESOURCE_HEALTH_KIND.missing,
  RESOURCE_HEALTH_KIND.invalid,
  RESOURCE_HEALTH_KIND.expired,
  RESOURCE_HEALTH_KIND.loggedOut,
  RESOURCE_HEALTH_KIND.toolMissing,
]);

/** un tipo de recurso anunciado con sus claves. */
export interface ResourceAnnounce {
  type: string;
  keys: string[];
}

/** un aviso de salud de una clave anunciada. */
export interface ResourceHealthIssue {
  type: string;
  key: string;
  kind: string;
}

/** lo que un daemon con sesiones de navegador expuestas a duckhunt anuncia en el cuerpo del claim legacy (t#495, M7).
 *  ausentes = un daemon sin ellas (o uno anterior): las sesiones guardadas de esa máquina se olvidan si el claim
 *  trae `awsDefault` (el daemon sabe de recursos) y se quedan si no. */
export interface LegacyClaimResources {
  resources?: ResourceAnnounce[];
  health?: ResourceHealthIssue[];
}
