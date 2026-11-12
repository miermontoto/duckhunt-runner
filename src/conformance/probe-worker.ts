// el proceso de una sonda de conformidad (t#440 P6): `duckhunt-runner conformance-probe <trabajo> <resultado>`, un
// subcomando oculto que lanza el orquestador (run-conformance.ts) con el env del entorno canario. lee el trabajo, lo
// lanza con el backend que toca y deja el resultado en su fichero. todo lo que el código del daemon resuelve desde el
// env (os.homedir, runnerHome, configPath) es aquí el canario: el HOME de verdad nunca entra en una sonda.
// decisiones:
// - el resultado va a un fichero, no a stdout: el driver y el daemon escriben su log por consola.
// - SIGTERM para la sonda como una parada del daemon (mata el grupo del cli) y aún escribe su resultado.

import fs from 'node:fs';
import { conformanceBackend } from './backend-registry.js';
import type { LaunchResult, ProbeJob } from './conformance-backend.js';

/** subcomando oculto del runner que corre una sonda. */
export const PROBE_WORKER_SUBCOMMAND = 'conformance-probe';
const RESULT_MODE = 0o600;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// el trabajo del fichero que escribió el orquestador; lanza si no tiene su forma.
function readJob(file: string): ProbeJob {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`el trabajo de la sonda (${file}) no se puede leer: ${(err as Error).message}`);
  }
  if (!isObj(raw) || typeof raw.backend !== 'string' || typeof raw.probe !== 'string' || typeof raw.providerUrl !== 'string' || !isObj(raw.canary) || !isObj(raw.cli)) {
    throw new Error(`el trabajo de la sonda (${file}) no tiene la forma de un ProbeJob`);
  }
  return raw as unknown as ProbeJob;
}

/** corre la sonda del trabajo `args[0]` y escribe su resultado en `args[1]` (ver cabecera). */
export async function probeWorkerCommand(args: readonly string[]): Promise<void> {
  const [jobFile, resultFile] = args;
  if (!jobFile || !resultFile) throw new Error(`uso: duckhunt-runner ${PROBE_WORKER_SUBCOMMAND} <trabajo.json> <resultado.json>`);
  const job = readJob(jobFile);
  const backend = conformanceBackend(job.backend);
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  const result: LaunchResult = backend
    ? await backend.launch(job, stop.signal)
    : { error: `el arnés no sabe medir el backend ${job.backend}`, exitCode: null, killedBy: null, status: null, notes: [] };
  fs.writeFileSync(resultFile, JSON.stringify(result), { mode: RESULT_MODE });
}
