// toolset_v1 (t#495, M5): lo que puede usar el agente de un run, en vocabulario neutro y sin ids de ningún cli. el
// server lo compone desde su política (services/agent-harness/toolset-v1.ts) y el daemon lo traduce a su backend
// (hoy claude code) tras cortarlo con el techo que el usuario le puso a la plataforma.
// decisiones:
// - fase en sombra: el server lo manda SOLO a un daemon que anuncia `toolset_v1`, junto a las listas de tools de
//   siempre, que siguen mandando. el daemon renderiza el toolset, lo compara con esas listas y devuelve el
//   resultado en el status del segmento (toolsetShadow). nada cambia de comportamiento hasta el flip.
// - fuera del cable: secretReadDeny (el daemon niega las lecturas de credenciales en todo kit sin shell entera) y el
//   permission mode (nunca bypassPermissions) son invariantes del daemon; proposeEdit y commentJira se quedan en el
//   server (son tools de su mcp, ya en platformTools, y texto del prompt).
// - grants: solo claves que el daemon anunció (el repo en su grafía, la cuenta aws del run si la anuncia). sin
//   cuenta anunciada no hay grant de aws: la identidad aws por defecto de la máquina es una clave que el usuario
//   expone a mano (`default`), nunca implícita. es la única diferencia buscada con las listas legacy, que dan la
//   aws en lectura a un run de lectura sin cuenta (TOOLSET_SHADOW_KNOWN.awsWithoutGrant).
// - explained: el daemon dice si la diferencia es SOLO la buscada, calculado sobre el diff entero (el que viaja va
//   recortado y no basta para decidirlo). el server solo avisa de lo que no casa y no está explicado: la diferencia
//   buscada de cada run de lectura sin cuenta taparía las de verdad.
// - vcsPush = el run puede empujar y tocar remotos (false = el deny de push y remotos de un prompt de regla
//   desatendido en edición por debajo del tier world).

export const TOOLSET_V1 = 1;

export const TOOLSET_SHELL = {
  none: 'none',
  read: 'read',
  full: 'full',
} as const;
export type ToolsetShell = (typeof TOOLSET_SHELL)[keyof typeof TOOLSET_SHELL];

/** nivel de acceso de un grant (el daemon lo corta con el techo de la plataforma: el mínimo de los dos). */
export const GRANT_ACCESS = {
  read: 'read',
  interact: 'interact',
  full: 'full',
} as const;
export type GrantAccess = (typeof GRANT_ACCESS)[keyof typeof GRANT_ACCESS];

/** tipos de recurso que concede el server hoy (el daemon conoce más: browser…). */
export const GRANT_TYPE = {
  repo: 'repo',
  aws: 'aws',
} as const;

/** un recurso de la máquina que el run puede usar: su tipo, la clave que el daemon anunció y el acceso (read si falta). */
export interface ToolsetGrant {
  type: string;
  key: string;
  access?: GrantAccess;
}

/** la política del run en vocabulario neutro (ver cabecera). */
export interface ToolsetV1 {
  v: typeof TOOLSET_V1;
  shell: ToolsetShell;
  // escribir ficheros (edición).
  fsWrite: boolean;
  // ampliar la memoria nativa del backend.
  memory: boolean;
  web: boolean;
  vcsPush: boolean;
  grants: ToolsetGrant[];
  // tools del mcp de la plataforma que el run puede llamar (sin prefijo de ningún cli).
  platformTools: string[];
}

/** diferencias explicadas por una decisión, no por un fallo del render (ver cabecera). */
export const TOOLSET_SHADOW_KNOWN = {
  // un run de lectura sin cuenta aws anunciada: el kit legacy lleva la aws en lectura (con la identidad por defecto
  // de la máquina) y toolset_v1 no la concede.
  awsWithoutGrant: 'aws_without_grant',
} as const;
export type ToolsetShadowKnown = (typeof TOOLSET_SHADOW_KNOWN)[keyof typeof TOOLSET_SHADOW_KNOWN];

/** lo que el render del daemon tiene de más o de menos frente a las listas del server (ids acotados en número y largo). */
export interface ToolsetShadowDiff {
  allowedMissing: string[];
  allowedExtra: string[];
  disallowedMissing: string[];
  disallowedExtra: string[];
  // el permission mode del daemon si difiere del que mandó el server (null = el mismo).
  permissionMode: string | null;
}

/** el resultado de la sombra en el status de un segmento: match = el render es idéntico a las listas del server. */
export interface ToolsetShadow {
  match: boolean;
  // casa, o lo único que no casa es lo que explica `known` (sobre el diff entero, antes de recortar).
  explained: boolean;
  // lo que explica la diferencia, si hay alguna explicada (TOOLSET_SHADOW_KNOWN).
  known: string[];
  // null con match.
  diff: ToolsetShadowDiff | null;
}
