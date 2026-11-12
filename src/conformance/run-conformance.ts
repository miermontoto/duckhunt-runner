// el orquestador del arnés de conformidad (t#440 P6): para cada sonda de un backend, un entorno canario nuevo, un
// proveedor guionizado con el guion de la sonda, el proceso de la sonda (probe-worker.ts) con el env del canario y, al
// acabar, el veredicto de lo que el proveedor grabó y de lo que quedó en disco. junta los veredictos, el estado de cada
// atestación y los avisos (rutas que el dialecto no conoce, salidas a la red rechazadas, notas del lanzador).
// decisiones:
// - las sondas van de una en una: dos a la vez se verían (el run-config, /proc) y el informe dejaría de ser de una.
// - el env de la sonda se construye entero (nada del env del usuario salvo PATH, idioma y usuario): HOME, TMPDIR y el
//   estado del runner del canario, el proxy de salida hacia el proveedor (que lo rechaza) y lo que el backend pone para
//   apuntar su cli al proveedor.
// - un proceso de sonda colgado se para con SIGTERM (para su cli) y, si no sale, SIGKILL; su sonda queda en error.
// - el canario se borra al acabar cada sonda salvo con `keep` (para mirarlo a mano): entonces deja también lo que grabó
//   el proveedor (PROVIDER_DUMP, sin credenciales en las cabeceras).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attestationVerdicts, type AttestationVerdict } from '../backends/attestation-evidence.js';
import { buildCanaryHome, removeCanaryHome, type CanaryHome } from './canary-home.js';
import type { CliInfo, ConformanceBackend, LaunchResult, ProbeJob } from './conformance-backend.js';
import { permissionRequests } from './platform-stub.js';
import type { Probe } from './probe.js';
import { PROBE_WORKER_SUBCOMMAND } from './probe-worker.js';
import { startScriptedProvider, type ScriptedProvider } from './scripted-provider.js';
import { judgeProbe, measuredProbe, skippedProbe, type LaunchSummary, type ProbeOutcome } from './verdict.js';

/** versión del formato del registro (la caché descarta otra). */
export const RECORD_VERSION = 1;
// el entrypoint del runner (dist/index.js), que lanza el proceso de cada sonda.
const RUNNER_ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));
// el reloj del proceso de la sonda: el del segmento (120 s) más la gracia del kill (10 s) y margen.
const WORKER_TIMEOUT_MS = 180_000;
const WORKER_KILL_GRACE_MS = 10_000;
const OUTPUT_TAIL_CHARS = 2000;
const FILE_MODE = 0o600;
const NO_PROXY_HOSTS = '127.0.0.1,localhost';
const PROBE_SHELLS = ['/bin/bash', '/bin/sh'];
const DEFAULT_LANG = 'C.UTF-8';
// lo único del env del usuario que pasa a la sonda (ver cabecera).
const PASSED_ENV = ['PATH', 'LANG', 'LC_ALL', 'USER', 'LOGNAME'] as const;
// lo que grabó el proveedor, en el canario conservado.
const PROVIDER_DUMP = 'provider.json';

/** lo que deja una ejecución del arnés (y lo que guarda la caché). */
export interface ConformanceRecord {
  v: typeof RECORD_VERSION;
  backend: string;
  cli: { version: string; sha256: string };
  os: string;
  harness: string;
  at: number;
  results: ProbeOutcome[];
  attestations: AttestationVerdict[];
  notes: string[];
}

/** qué medir y cómo. */
export interface ConformanceOptions {
  backend: ConformanceBackend;
  cli: CliInfo;
  sha256: string;
  os: string;
  harness: string;
  // el env del que salen PATH, idioma y usuario.
  env: NodeJS.ProcessEnv;
  // solo estas sondas (ids); ausente = todas.
  only?: readonly string[];
  keep?: boolean;
  // dónde crear los canarios (el tmpdir por defecto).
  tmpParent?: string;
  // el entrypoint del runner para el proceso de la sonda (las pruebas usan el suyo).
  workerEntry?: string;
  // cada sonda al cerrarse (progreso) y el canario que se conserva con `keep`.
  onProbe?: (outcome: ProbeOutcome, keptAt: string | null) => void;
}

const probeShell = (): string => PROBE_SHELLS.find((s) => fs.existsSync(s)) ?? PROBE_SHELLS[PROBE_SHELLS.length - 1]!;

/** el env entero del proceso de una sonda (ver cabecera). */
export function probeEnv(base: NodeJS.ProcessEnv, c: CanaryHome, providerUrl: string, backend: ConformanceBackend): NodeJS.ProcessEnv {
  const passed = Object.fromEntries(PASSED_ENV.flatMap((k) => (base[k] === undefined ? [] : [[k, base[k]]])));
  return {
    LANG: DEFAULT_LANG,
    ...passed,
    HOME: c.home,
    TMPDIR: c.tmp,
    SHELL: probeShell(),
    DUCKHUNT_RUNNER_HOME: c.runnerHome,
    DUCKHUNT_RUNNER_CONFIG: c.runnerConfig,
    HTTP_PROXY: providerUrl,
    HTTPS_PROXY: providerUrl,
    http_proxy: providerUrl,
    https_proxy: providerUrl,
    NO_PROXY: NO_PROXY_HOSTS,
    no_proxy: NO_PROXY_HOSTS,
    ...backend.providerEnv(providerUrl),
  };
}

const failedLaunch = (error: string): LaunchResult => ({ error, exitCode: null, killedBy: null, status: null, notes: [] });

// el resultado que dejó el proceso de la sonda, o por qué no hay.
function readResult(file: string, exit: string, tail: string): LaunchResult {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return failedLaunch(`el proceso de la sonda ${exit} sin resultado (${(err as Error).message})${tail ? `: ${tail}` : ''}`);
  }
  const r = raw as Partial<LaunchResult> | null;
  if (r === null || typeof r !== 'object' || !Array.isArray(r.notes)) return failedLaunch(`el proceso de la sonda dejó un resultado sin forma: ${tail}`);
  return { error: typeof r.error === 'string' ? r.error : null, exitCode: r.exitCode ?? null, killedBy: r.killedBy ?? null, status: r.status ?? null, notes: r.notes };
}

// lanza el proceso de la sonda y espera su resultado (ver cabecera).
function runWorker(entry: string, job: ProbeJob, env: NodeJS.ProcessEnv): Promise<LaunchResult> {
  const jobFile = path.join(job.canary.root, 'job.json');
  const resultFile = path.join(job.canary.root, 'result.json');
  fs.writeFileSync(jobFile, JSON.stringify(job), { mode: FILE_MODE });
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(process.execPath, [entry, PROBE_WORKER_SUBCOMMAND, jobFile, resultFile], { cwd: job.canary.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), WORKER_KILL_GRACE_MS).unref();
    }, WORKER_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(failedLaunch(`no se pudo lanzar el proceso de la sonda: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result = readResult(resultFile, signal ? `murió por ${signal}` : `salió con ${code}`, output.trim());
      resolve(hung && result.error === null ? { ...result, error: `la sonda superó ${WORKER_TIMEOUT_MS / 1000}s y se paró` } : result);
    });
  });
}

// lo que el proveedor grabó que el informe debe contar: rutas sin guion y salidas rechazadas.
const providerNotes = (p: ScriptedProvider): string[] => [
  ...p.requests.filter((r) => !r.handled).map((r) => `ruta sin guion: ${r.method} ${r.path}`),
  ...p.egress.map((e) => `salida a la red rechazada: ${e}`),
];

// cuenta las repetidas: «x (×3)».
const counted = (notes: readonly string[]): string[] =>
  Array.from(new Set(notes)).map((n) => {
    const times = notes.filter((o) => o === n).length;
    return times > 1 ? `${n} (×${times})` : n;
  });

// una sonda: su canario, su proveedor y su proceso, y el veredicto.
async function runProbe(o: ConformanceOptions, probe: Probe, entry: string): Promise<{ outcome: ProbeOutcome; notes: string[]; keptAt: string | null }> {
  if (probe.platforms && !probe.platforms.includes(process.platform)) return { outcome: skippedProbe(probe, process.platform), notes: [], keptAt: null };
  const canary = buildCanaryHome(o.tmpParent, o.env);
  const provider = await startScriptedProvider(o.backend.dialect, probe.script(canary));
  try {
    const job: ProbeJob = { backend: o.backend.id, probe: probe.id, canary, providerUrl: provider.url, cli: o.cli };
    const launch = await runWorker(entry, job, probeEnv(o.env, canary, provider.url, o.backend));
    const summary: LaunchSummary = { error: launch.error };
    const outcome = judgeProbe(probe, canary, o.backend.dialect.observe(provider.requests), summary);
    const asked = permissionRequests(provider.requests);
    const notes = [
      ...providerNotes(provider),
      ...launch.notes.map((n) => `${probe.id}: ${n}`),
      ...(asked > 0 ? [`${probe.id}: ${asked} petición(es) de permiso, aprobadas por la plataforma de la sonda`] : []),
    ];
    return { outcome, notes, keptAt: o.keep ? canary.root : null };
  } finally {
    await provider.close();
    if (o.keep) fs.writeFileSync(path.join(canary.root, PROVIDER_DUMP), JSON.stringify({ requests: provider.requests, egress: provider.egress }, null, 1), { mode: FILE_MODE });
    else removeCanaryHome(canary);
  }
}

/** mide las sondas del backend contra su cli instalado (ver cabecera). */
export async function runConformance(o: ConformanceOptions): Promise<ConformanceRecord> {
  const unknown = (o.only ?? []).filter((id) => !o.backend.probes.some((p) => p.id === id));
  if (unknown.length > 0) throw new Error(`sondas desconocidas para ${o.backend.id}: ${unknown.join(', ')}`);
  const probes = o.only ? o.backend.probes.filter((p) => o.only!.includes(p.id)) : o.backend.probes;
  const entry = o.workerEntry ?? RUNNER_ENTRY;
  const results: ProbeOutcome[] = [];
  const notes: string[] = [];
  // i/o secuencial a propósito (ver cabecera).
  for (const probe of probes) {
    const r = await runProbe(o, probe, entry);
    results.push(r.outcome);
    notes.push(...r.notes);
    o.onProbe?.(r.outcome, r.keptAt);
  }
  return {
    v: RECORD_VERSION,
    backend: o.backend.id,
    cli: { version: o.cli.version, sha256: o.sha256 },
    os: o.os,
    harness: o.harness,
    at: Date.now(),
    results,
    attestations: attestationVerdicts(results.map(measuredProbe)),
    notes: [...o.backend.notes(o.cli), ...counted(notes)],
  };
}
