// los drivers de agente del daemon por backend (t#440 P1), como resources/registry.ts para los recursos. el primero es
// el principal: el que anuncia las capabilities planas del cable legacy y ejecuta todo run hasta que el claim diga su
// backend (P4). en producción es claude code; las pruebas inyectan los suyos (DaemonOptions.drivers).

import type { AgentDriver } from './agent-driver.js';

export class DriverRegistry {
  private readonly byId: ReadonlyMap<string, AgentDriver>;

  constructor(readonly drivers: readonly AgentDriver[]) {
    if (drivers.length === 0) throw new Error('el daemon necesita al menos un driver de agente');
    const ids = drivers.map((d) => d.id);
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (repeated.length > 0) throw new Error(`driver de agente repetido: ${[...new Set(repeated)].join(', ')}`);
    this.byId = new Map(drivers.map((d) => [d.id, d]));
  }

  /** el driver principal (el primero registrado). */
  get primary(): AgentDriver {
    return this.drivers[0]!;
  }

  /** el driver de un backend; lanza si el daemon no lo tiene. */
  get(id: string): AgentDriver {
    const driver = this.byId.get(id);
    if (!driver) throw new Error(`el daemon no tiene driver para el backend ${id}`);
    return driver;
  }

  /** la versión del cli de un backend; null si no está o el daemon no tiene su driver. */
  versionOf(id: string): string | null {
    return this.byId.get(id)?.version ?? null;
  }

  /** detecta el cli de cada driver. */
  async detect(): Promise<void> {
    await Promise.all(this.drivers.map((d) => d.detect()));
  }
}
