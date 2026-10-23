// el flip de toolset_v1 en el cable legacy (t#495, M5): un claim de duckhunt-42 que trae `toolset` se lanza con el
// render del daemon (el toolset ∩ el techo que el usuario le puso a la plataforma; un run de lectura, además, sin
// escribir ni shell entera) y no con las listas del server, que siguen viajando y pasan a ser la comparación
// (toolset/shadow.ts, el mismo toolsetShadow del status). lo apaga `defaults.toolsetRender: false` (daemon.ts).
// lo que corre sale de aquí:
// - antes de nada, cada grant contra la máquina (platforms/claim-v0.ts::checkGrants): un tipo que este daemon no sirve
//   en un run, una clave que el usuario no expuso a la plataforma o un tipo sin acceso en el
//   techo rechazan el claim entero con su código (ClaimRejectedError). nunca se corre quitando un grant en silencio.
// - recursos = los grants: el repo con la rama del claim y el aislamiento de siempre (kind / isolation: los mismos
//   worktrees conv-<id> de este cable), la aws con su clave (la cuenta, o `default`) y la región del claim.
// - lo que el claim nombra sin grant se pide igual, para que degrade como hoy: un repo que la máquina no mapea (al
//   scratch, con su aviso) o una cuenta aws que no anuncia (la aws vacía, con su aviso: aws_strict). el server concede
//   todo lo mapeado y expuesto, así que esa petición solo puede degradar. un run sin cuenta ni grant de aws corre con
//   la aws aislada: la identidad por defecto de la máquina solo llega con su grant (`default`, si la anuncia).
// - las listas renderizadas pasan por la misma criba que las del server (claim.ts::withRenderedTools).
// - autonomía (t#527): fuera de dontAsk el allow deja de ser el límite (manual pregunta, auto lo decide el cli, bypass
//   todo lo que no niega el deny), así que un techo que recorta la shell, la escritura, la web o las tools de la
//   plataforma no se puede cumplir con listas: el claim se rechaza (resource_not_allowed). el push y los remotos sí,
//   por el deny (VCS_PUSH_DENY manda también en bypass).

import { TOOLSET_V1, withRenderedTools, type ClaimedRun, type ClaimResponse } from '../claim.js';
import { checkGrants, CLAIM_REJECT, ClaimRejectedError, forProfile, type V0Enforcement } from '../platforms/claim-v0.js';
import { AWS_PARAM, AWS_TYPE } from '../resources/aws.js';
import { legacyRepoParams, legacyRequests } from '../resources/legacy.js';
import { REPO_TYPE } from '../resources/repo/provider.js';
import { ACCESS, type ResourceRequest } from '../resources/types.js';
import type { ToolsetGrant } from '../vendor/runner-protocol/index.js';
import { intersectToolset } from './intersect.js';
import { renderClaudeTools } from './render.js';

// lo que el techo puede recortar y una autonomía no cumple solo con listas (ver cabecera): los nombres de `narrowed`.
const AUTONOMY_UNENFORCEABLE: readonly string[] = ['shell', 'fsWrite', 'web', 'platformTools'];

/** lo que el daemon aplica al claim legacy de una plataforma (su config de AHORA y la máquina). */
export type LegacyEnforcement = Pick<V0Enforcement, 'ceiling' | 'expose' | 'resourceTypes' | 'awsCli'>;

/** el claim que se lanza y lo que el techo (o el perfil) le recortó al toolset. */
export interface LegacyRender {
  claim: ClaimResponse;
  narrowed: string[];
}

// las peticiones de recursos de un claim que manda con su toolset (ver cabecera).
function requestsOf(grants: readonly ToolsetGrant[], run: ClaimedRun): ResourceRequest[] {
  const legacy = legacyRequests(run);
  const granted = (type: string): ToolsetGrant | undefined => grants.find((g) => g.type === type);
  const repo = granted(REPO_TYPE);
  const aws = granted(AWS_TYPE);
  const access = (g: ToolsetGrant): ResourceRequest['access'] => g.access ?? ACCESS.read;
  return [
    ...(repo ? [{ type: REPO_TYPE, key: repo.key, access: access(repo), params: legacyRepoParams(run) }] : legacy.filter((r) => r.type === REPO_TYPE)),
    ...(aws
      ? [{ type: AWS_TYPE, key: aws.key, access: access(aws), params: { [AWS_PARAM.region]: run.aws?.region ?? null } }]
      : run.aws?.accountId
        ? legacy.filter((r) => r.type === AWS_TYPE)
        : []),
    // los demás tipos (los que sirva el daemon más adelante): su grant tal cual.
    ...grants.filter((g) => g.type !== REPO_TYPE && g.type !== AWS_TYPE).map((g) => ({ type: g.type, key: g.key, access: access(g), params: {} })),
  ];
}

/** el claim legacy con su toolset aplicado (ver cabecera); sin toolset, tal cual. lanza ClaimRejectedError. */
export function renderLegacyClaim(claim: ClaimResponse, e: LegacyEnforcement): LegacyRender {
  const source = claim.toolsetShadow;
  if (source === null) return { claim, narrowed: [] };
  checkGrants(source.toolset, e);
  const ceiled = intersectToolset(source.toolset, e.ceiling);
  const beyondAllow = ceiled.narrowed.filter((n) => AUTONOMY_UNENFORCEABLE.includes(n));
  if (source.toolset.autonomy !== undefined && beyondAllow.length > 0) {
    throw new ClaimRejectedError(CLAIM_REJECT.notAllowed, `autonomía ${source.toolset.autonomy}: el techo de la plataforma recorta ${beyondAllow.join(', ')} y fuera de dontAsk el allow no lo cumple`);
  }
  const { toolset, narrowed: byProfile } = claim.run.profile === null ? { toolset: ceiled.toolset, narrowed: [] } : forProfile(ceiled.toolset, claim.run.profile);
  const narrowed = [...ceiled.narrowed, ...byProfile];
  let rendered: ClaimResponse;
  try {
    rendered = withRenderedTools(claim, renderClaudeTools(toolset, { mcpServerName: claim.mcp.serverName, awsCli: e.awsCli }));
  } catch (err) {
    throw new ClaimRejectedError(CLAIM_REJECT.invalid, (err as Error).message);
  }
  return {
    claim: {
      ...rendered,
      // manda con toolset_v1: la aws de la máquina se aísla si no hay grant (resources/aws.ts::isolate).
      toolset: { v: TOOLSET_V1 },
      resources: requestsOf(toolset.grants, claim.run),
      policyAudit: { requested: source.toolset, effective: toolset, narrowed },
    },
    narrowed,
  };
}
