// plataformas del runner (t#495): quien le encarga runs (duckhunt la primera). de cada una la config local guarda su
// credencial, qué recursos de la máquina le expone el usuario y el techo de lo que puede pedir (ToolsetCeiling: la
// política efectiva será la petición de la plataforma ∩ ese techo, M5; hasta entonces se guarda y no se aplica).
// decisiones:
// - la legacy (duckhunt) arranca con lo de siempre: todos sus repos y cuentas aws expuestos y el techo de hoy, todo
//   lo que su kit puede pedir (shell entera en edición, escritura, memoria nativa, web, push y la aws cli con el
//   perfil de la cuenta). el permission mode (nunca bypassPermissions, claim.ts::ALLOWED_PERMISSION_MODES) no es
//   del techo: es un invariante del daemon para toda plataforma.
// - una plataforma nueva arranca sin nada expuesto y con el techo más bajo.
// - shell:'full' solo en una plataforma marcada trusted (duckhunt y la local); el resto, como mucho 'read'.

import type { RunnerCredential } from '../config.js';
import { ACCESS, RESOURCE_TYPE, type Access } from '../resources/types.js';

export const SHELL = {
  none: 'none',
  read: 'read',
  full: 'full',
} as const;
export type Shell = (typeof SHELL)[keyof typeof SHELL];

// todas las claves de un tipo de recurso expuestas (las que haya ahora y las que se mapeen después).
export const EXPOSE_ALL = '*';
export type Exposure = typeof EXPOSE_ALL | readonly string[];

/** lo más que una plataforma puede pedir para un run. un tipo de recurso ausente en `access` = sin grants de él. */
export interface ToolsetCeiling {
  shell: Shell;
  fsWrite: boolean;
  memory: boolean;
  web: boolean;
  vcsPush: boolean;
  access: Readonly<Record<string, Access>>;
  // tools del mcp de la plataforma que puede dar ('*' = las que mande).
  platformTools: typeof EXPOSE_ALL | readonly string[];
}

export interface PlatformConfig {
  // ausente tras `logout` (o antes del primer `login`).
  credential?: RunnerCredential;
  // de confianza: la única que puede tener shell:'full' en su techo.
  trusted: boolean;
  // tipo de recurso → claves que ve (ausente = ninguna).
  expose: Readonly<Record<string, Exposure>>;
  ceiling: ToolsetCeiling;
}

/** el techo de duckhunt: lo que su kit puede pedir hoy. */
export const LEGACY_CEILING: ToolsetCeiling = {
  shell: SHELL.full,
  fsWrite: true,
  memory: true,
  web: true,
  vcsPush: true,
  access: { [RESOURCE_TYPE.repo]: ACCESS.full, [RESOURCE_TYPE.aws]: ACCESS.full },
  platformTools: EXPOSE_ALL,
};

/** lo que la legacy ve de la máquina: todos sus repos y cuentas, como siempre. */
export const LEGACY_EXPOSE: Readonly<Record<string, Exposure>> = { [RESOURCE_TYPE.repo]: EXPOSE_ALL, [RESOURCE_TYPE.aws]: EXPOSE_ALL };

/** el techo de una plataforma nueva: nada. */
export const DEFAULT_CEILING: ToolsetCeiling = {
  shell: SHELL.none,
  fsWrite: false,
  memory: false,
  web: false,
  vcsPush: false,
  access: {},
  platformTools: EXPOSE_ALL,
};
