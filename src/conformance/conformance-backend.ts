// lo que un backend de agente aporta al arnés de conformidad (t#440 P6): cómo se detecta su cli, con qué dialecto habla
// a su proveedor, cómo se le apunta al proveedor guionizado, sus sondas y cómo lanza una sonda tal como lo haría el
// daemon. el orquestador (run-conformance.ts) solo conoce este contrato; claude code es el primero
// (claude/claude-conformance.ts) y codex (P7) el siguiente.
// decisiones:
// - `launch` corre dentro del proceso de la sonda (probe-worker.ts), con el HOME, el estado del runner y el env del
//   entorno canario: el código del daemon que resuelve rutas desde el env (runnerHome, os.homedir) ve el canario.
// - el trabajo de la sonda viaja en un fichero json (ProbeJob): el entorno canario entero es serializable.

import type { CanaryHome } from './canary-home.js';
import type { Probe } from './probe.js';
import type { ProviderDialect } from './provider-dialect.js';

/** el cli instalado: su versión y los flags que lista su ayuda. */
export interface CliInfo {
  version: string;
  flags: string[];
}

/** el trabajo de una sonda para su proceso (ver cabecera). */
export interface ProbeJob {
  backend: string;
  probe: string;
  canary: CanaryHome;
  providerUrl: string;
  cli: CliInfo;
}

/** cómo fue el lanzamiento, contado por el proceso de la sonda. error = no llegó a lanzarse (o se cayó el arnés). */
export interface LaunchResult {
  error: string | null;
  exitCode: number | null;
  killedBy: string | null;
  status: string | null;
  // lo que el lanzador avisó por el camino (la guarda de la shell de lectura, un reintento).
  notes: string[];
}

/** un backend de agente para el arnés (ver cabecera). */
export interface ConformanceBackend {
  // el backend (RUNNER_BACKEND del protocolo).
  readonly id: string;
  // el ejecutable que se busca en el PATH.
  readonly command: string;
  readonly dialect: ProviderDialect;
  readonly probes: readonly Probe[];
  /** versión y flags del cli instalado con `env`; null = no está o no arranca. */
  detect(env: NodeJS.ProcessEnv): Promise<CliInfo | null>;
  /** el env que apunta el cli al proveedor guionizado en `url` (sin red y sin gastar nada). */
  providerEnv(url: string): Record<string, string>;
  /** avisos sobre el cli detectado (flags que el daemon quiere y no están). */
  notes(cli: CliInfo): string[];
  /** lanza la sonda como el daemon (en el proceso de la sonda); `signal` la para. nunca lanza: un fallo va en `error`. */
  launch(job: ProbeJob, signal: AbortSignal): Promise<LaunchResult>;
}
