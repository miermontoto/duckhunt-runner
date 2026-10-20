// toolset_v1 en sombra (t#495, M5): el daemon renderiza el toolset que mandó la plataforma (cortado por el techo
// que el usuario le puso) y lo compara con las listas de tools que trajo el claim, que son las que siguen mandando.
// el resultado viaja en el status del segmento (toolsetShadow) y, si no casa, se loguea aquí también.
// decisiones:
// - se compara con las listas TAL CUAL las mandó el server, antes de lo que el parse del claim les añade o quita
//   (el deny forzado de lectura, las `Bash(aws …)` que no reconoce): eso es del daemon con cualquier toolset.
// - casar = las mismas ids en cada lista (como conjunto: el cli no mira el orden) y el mismo permission mode.
// - una diferencia que explica una decisión, no un fallo del render, se nombra en `known`
//   (TOOLSET_SHADOW_KNOWN): hoy solo la aws en lectura de un run sin grant de aws (el kit legacy la da con la
//   identidad por defecto de la máquina; toolset_v1 no).
// - el diff se recorta a los topes del server (RUNNER_TOOLSET_SHADOW_*): es para un log, no para reproducir el kit.

import {
  GRANT_TYPE,
  RUNNER_TOOLSET_SHADOW_ID_MAX_CHARS,
  RUNNER_TOOLSET_SHADOW_IDS_MAX,
  TOOLSET_SHADOW_KNOWN,
  TOOLSET_SHELL,
  type ToolsetShadow,
  type ToolsetShadowDiff,
  type ToolsetV1,
} from '../vendor/runner-protocol/index.js';
import type { ToolsetCeiling } from '../platforms/types.js';
import { intersectToolset } from './intersect.js';
import { AWS_READ_ALLOWED, renderClaudeTools, type ClaudeTools, type RenderContext } from './render.js';

const AWS_READ_ALLOWED_SET: ReadonlySet<string> = new Set(AWS_READ_ALLOWED);

// lo de `a` que no está en `b`, en el orden de `a`.
const missingFrom = (a: readonly string[], b: readonly string[]): string[] => {
  const inB = new Set(b);
  return a.filter((id) => !inB.has(id));
};

const clipIds = (ids: readonly string[]): string[] => ids.slice(0, RUNNER_TOOLSET_SHADOW_IDS_MAX).map((id) => id.slice(0, RUNNER_TOOLSET_SHADOW_ID_MAX_CHARS));

/** la sombra para el status y si su diferencia es SOLO la buscada (calculado sobre el diff entero, antes de recortar). */
export interface ShadowResult {
  shadow: ToolsetShadow;
  // casa, o lo único que no casa son los patrones de la aws en lectura de un run sin grant de aws.
  explained: boolean;
}

/** la sombra de un toolset ya cortado frente a las listas del server (ver cabecera). */
export function compareToolset(server: ClaudeTools, t: ToolsetV1, ctx: RenderContext): ShadowResult {
  const rendered = renderClaudeTools(t, ctx);
  const diff: ToolsetShadowDiff = {
    allowedMissing: missingFrom(server.allowed, rendered.allowed),
    allowedExtra: missingFrom(rendered.allowed, server.allowed),
    disallowedMissing: missingFrom(server.disallowed, rendered.disallowed),
    disallowedExtra: missingFrom(rendered.disallowed, server.disallowed),
    permissionMode: rendered.permissionMode === server.permissionMode ? null : rendered.permissionMode,
  };
  const rest = [diff.allowedExtra, diff.disallowedMissing, diff.disallowedExtra];
  const match = diff.permissionMode === null && [diff.allowedMissing, ...rest].every((ids) => ids.length === 0);
  if (match) return { shadow: { match, known: [], diff: null }, explained: true };
  const awsWithoutGrant =
    t.shell === TOOLSET_SHELL.read &&
    ctx.awsCli &&
    !t.grants.some((g) => g.type === GRANT_TYPE.aws) &&
    diff.allowedMissing.some((id) => AWS_READ_ALLOWED_SET.has(id));
  const unexplained = awsWithoutGrant ? diff.allowedMissing.filter((id) => !AWS_READ_ALLOWED_SET.has(id)) : diff.allowedMissing;
  return {
    shadow: {
      match,
      known: awsWithoutGrant ? [TOOLSET_SHADOW_KNOWN.awsWithoutGrant] : [],
      diff: {
        allowedMissing: clipIds(diff.allowedMissing),
        allowedExtra: clipIds(diff.allowedExtra),
        disallowedMissing: clipIds(diff.disallowedMissing),
        disallowedExtra: clipIds(diff.disallowedExtra),
        permissionMode: diff.permissionMode,
      },
    },
    explained: diff.permissionMode === null && [unexplained, ...rest].every((ids) => ids.length === 0),
  };
}

/** lo que el claim trae para la sombra: el toolset y las listas del server tal cual llegaron. */
export interface ShadowSource {
  toolset: ToolsetV1;
  server: ClaudeTools;
}

/** la sombra de un claim: su toolset ∩ el techo de la plataforma frente a sus listas, con lo que el techo recortó. */
export function shadowOf(source: ShadowSource, ceiling: ToolsetCeiling, ctx: RenderContext): ShadowResult & { narrowed: string[] } {
  const { toolset, narrowed } = intersectToolset(source.toolset, ceiling);
  return { ...compareToolset(source.server, toolset, ctx), narrowed };
}
