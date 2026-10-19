// registro de proveedores de recursos (t#495, M2): un proveedor por tipo, y la traducción de las peticiones de un
// run a su plan (proveedor + entrada de la config local). un tipo que nadie sirve no se reclama a medias: el plan
// lanza y el run falla sin lanzarse. con `isolate` (claims toolset_v1) cada proveedor que sabe aislar y no tiene
// petición entra en el plan sin ella: la aws de la máquina no se le cuela a un run que no la pidió.

import { ResourceUnavailableError, UNAVAILABLE_KIND, type ResourceProvider, type ResourceRequest } from './types.js';

/** un paso del plan: request null = aislar (ResourceProvider.isolate). */
export interface PlannedResource {
  provider: ResourceProvider;
  request: ResourceRequest | null;
  ref: unknown;
}

/** entrada de la config local para un tipo y una clave (null = sin mapear en esta máquina). */
export type RefLookup = (type: string, key: string | null) => unknown;

export class ProviderRegistry {
  private readonly byType: ReadonlyMap<string, ResourceProvider>;

  constructor(providers: readonly ResourceProvider[]) {
    this.byType = new Map(providers.map((p) => [p.type, p]));
    if (this.byType.size !== providers.length) throw new Error('dos proveedores de recursos con el mismo tipo');
  }

  get(type: string): ResourceProvider | null {
    return this.byType.get(type) ?? null;
  }

  types(): string[] {
    return [...this.byType.keys()];
  }

  /** plan de un run: cada petición con su proveedor y su ref; con `isolate`, los tipos aislables sin petición. */
  plan(requests: readonly ResourceRequest[], refOf: RefLookup, isolate = false): PlannedResource[] {
    const requested = requests.map((request) => {
      const provider = this.get(request.type);
      if (!provider) throw new ResourceUnavailableError(request.type, request.key, UNAVAILABLE_KIND.unknownType);
      return { provider, request, ref: refOf(request.type, request.key) ?? null };
    });
    const isolated = isolate
      ? [...this.byType.values()].filter((p) => p.isolate && !requests.some((r) => r.type === p.type)).map((provider) => ({ provider, request: null, ref: null }))
      : [];
    return [...requested, ...isolated];
  }

  /** barrido al arrancar (con el lock del daemon): lo que dejaron los runs de un daemon muerto. devuelve cuántos. */
  sweep(platform: string): number {
    return [...this.byType.values()].reduce((n, p) => n + (p.sweep?.(platform) ?? 0), 0);
  }
}
