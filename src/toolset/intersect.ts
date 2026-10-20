// toolset_v1 ∩ techo de la plataforma (t#495, M5): la política efectiva de un run es lo que pide la plataforma
// cortado por lo que el usuario le dejó pedir (platforms/types.ts::ToolsetCeiling). el corte es el mínimo de cada
// nivel (shell none < read < full, acceso read < interact < full) y el AND de cada flag; un grant de un tipo que el
// techo no concede se cae; las tools de la plataforma, solo las que el techo nombra ('*' = todas).
// decisiones:
// - acotar no es rechazar: lo que el techo recorta se anota (`narrowed`, para el log) y el run sigue con lo que
//   queda. rechazar es de la validación (parse.ts) y de la exposición de claves (lo que la máquina no expone a la
//   plataforma no se materializa).
// - un grant sin access vale read (el mínimo).

import { GRANT_ACCESS, TOOLSET_SHELL, type GrantAccess, type ToolsetGrant, type ToolsetShell, type ToolsetV1 } from '../vendor/runner-protocol/index.js';
import { EXPOSE_ALL, type ToolsetCeiling } from '../platforms/types.js';

const SHELL_RANK: Readonly<Record<ToolsetShell, number>> = { [TOOLSET_SHELL.none]: 0, [TOOLSET_SHELL.read]: 1, [TOOLSET_SHELL.full]: 2 };
const ACCESS_RANK: Readonly<Record<GrantAccess, number>> = { [GRANT_ACCESS.read]: 0, [GRANT_ACCESS.interact]: 1, [GRANT_ACCESS.full]: 2 };
const FLAG_KEYS = ['fsWrite', 'memory', 'web', 'vcsPush'] as const;

/** el toolset efectivo y lo que el techo recortó (nombres de campo, `grant:<tipo>:<clave>`, `platformTools`). */
export interface Intersected {
  toolset: ToolsetV1;
  narrowed: string[];
}

const minBy = <T extends string>(rank: Readonly<Record<T, number>>, a: T, b: T): T => (rank[a] <= rank[b] ? a : b);

/** toolset ∩ techo (ver cabecera). */
export function intersectToolset(t: ToolsetV1, ceiling: ToolsetCeiling): Intersected {
  const shell = minBy(SHELL_RANK, t.shell, ceiling.shell);
  const flags = Object.fromEntries(FLAG_KEYS.map((k) => [k, t[k] && ceiling[k]])) as Pick<ToolsetV1, (typeof FLAG_KEYS)[number]>;
  const grants = t.grants.flatMap((g): ToolsetGrant[] => {
    const top = Object.hasOwn(ceiling.access, g.type) ? ceiling.access[g.type] : undefined;
    return top === undefined ? [] : [{ ...g, access: minBy(ACCESS_RANK, g.access ?? GRANT_ACCESS.read, top) }];
  });
  const platformTools = ceiling.platformTools === EXPOSE_ALL ? t.platformTools : t.platformTools.filter((tool) => ceiling.platformTools.includes(tool));
  const kept = new Map(grants.map((g) => [`${g.type}:${g.key}`, g]));
  const narrowed = [
    ...(shell !== t.shell ? ['shell'] : []),
    ...FLAG_KEYS.filter((k) => flags[k] !== t[k]),
    ...t.grants
      .filter((g) => kept.get(`${g.type}:${g.key}`)?.access !== (g.access ?? GRANT_ACCESS.read))
      .map((g) => `grant:${g.type}:${g.key}`),
    ...(platformTools.length !== t.platformTools.length ? ['platformTools'] : []),
  ];
  return { toolset: { ...t, shell, ...flags, grants, platformTools }, narrowed };
}
