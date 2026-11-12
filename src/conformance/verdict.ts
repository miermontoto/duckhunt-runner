// el veredicto de una sonda de conformidad (t#440 P6), puro: de lo que el cli le contó al proveedor, de lo que quedó en
// disco y de cómo se lanzó, si la garantía se cumplió. nunca mira el texto del modelo.
// decisiones:
// - primero que la medida valga: el run se lanzó, cada conversación del guion llegó al proveedor, cada paso del guion
//   tiene su resultado y cada control se ve. si no, ERROR (el arnés no supo medir), nunca un pass por omisión.
// - después las comprobaciones: con alguna rota, el valor canario llegó adonde no debía.
// - un hueco conocido (`gap`) invierte lo esperado: roto = XFAIL (lo sabido), cumplido = XPASS (¿se cerró? revisar la
//   expectativa). sin hueco: cumplido = PASS, roto = FAIL.

import fs from 'node:fs';
import type { BackendAttestation, MeasuredProbe } from '../backends/attestation-evidence.js';
import type { CanaryHome } from './canary-home.js';
import { SCRIPT_ROLE, type Probe, type ProbeCheck, type ProbeControl, type ScriptRole } from './probe.js';
import type { ProviderObservation } from './provider-dialect.js';

/** el veredicto de una sonda (ver cabecera). */
export const VERDICT = {
  pass: 'PASS',
  fail: 'FAIL',
  xfail: 'XFAIL',
  xpass: 'XPASS',
  error: 'ERROR',
  skip: 'SKIP',
} as const;
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

/** cómo quedó una sonda: lo que se esperaba, lo que se vio y el veredicto. */
export interface ProbeOutcome {
  id: string;
  title: string;
  attestations: BackendAttestation[];
  gap: string | null;
  verdict: Verdict;
  expected: string;
  observed: string;
}

/** lo que el arnés sabe del lanzamiento: null = se lanzó; si no, por qué no. */
export interface LaunchSummary {
  error: string | null;
}

/** cómo se mira el disco (inyectable en las pruebas). */
export interface FileView {
  exists(file: string): boolean;
  read(file: string): string | null;
}

export const DISK: FileView = {
  exists: (file) => fs.existsSync(file),
  read: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
};

const HELD = 'se cumple';
const expectedOf = (gap: string | null): string => (gap === null ? HELD : `se rompe (${gap})`);

const resultOf = (obs: ProviderObservation, role: ScriptRole, step: number): string | null => obs.results.find((r) => r.role === role && r.step === step)?.text ?? null;

// ¿se ve el control?
function controlHolds(c: ProbeControl, obs: ProviderObservation, files: FileView): boolean {
  if (c.kind === 'result_has') return resultOf(obs, c.role, c.step)?.includes(c.value) === true;
  return files.read(c.path)?.includes(c.value) === true;
}

// ¿se cumple la comprobación?
function checkHolds(c: ProbeCheck, obs: ProviderObservation, files: FileView): boolean {
  switch (c.kind) {
    case 'result_lacks':
      return resultOf(obs, c.role, c.step)?.includes(c.value) !== true;
    case 'context_lacks':
      return !obs.context.includes(c.value);
    case 'file_absent':
      return !files.exists(c.path);
    case 'file_lacks':
      return files.read(c.path)?.includes(c.value) !== true;
    case 'tool_not_offered':
      return !obs.offeredTools.some((t) => t.startsWith(c.prefix));
  }
}

// por qué la medida no vale, o null si vale (ver cabecera).
function measurementError(probe: Probe, canary: CanaryHome, obs: ProviderObservation, launch: LaunchSummary, files: FileView): string | null {
  if (launch.error !== null) return `no se lanzó: ${launch.error}`;
  const script = probe.script(canary);
  const roles = Array.from(new Set<ScriptRole>([SCRIPT_ROLE.main, ...(Object.keys(script) as ScriptRole[])]));
  const missingRole = roles.find((r) => !obs.roles.includes(r));
  if (missingRole !== undefined) return `la conversación ${missingRole} nunca llegó al proveedor`;
  const unanswered = roles.flatMap((role) => (script[role] ?? []).map((call, step) => ({ role, step, tool: call.tool }))).find((s) => resultOf(obs, s.role, s.step) === null);
  if (unanswered !== undefined) return `el cli nunca devolvió el resultado del paso ${unanswered.step} de ${unanswered.role} (${unanswered.tool})`;
  const control = probe.controls(canary).find((c) => !controlHolds(c, obs, files));
  return control === undefined ? null : `control fallido: ${control.label}`;
}

/** el veredicto de una sonda medida (ver cabecera). */
export function judgeProbe(probe: Probe, canary: CanaryHome, obs: ProviderObservation, launch: LaunchSummary, files: FileView = DISK): ProbeOutcome {
  const base = { id: probe.id, title: probe.title, attestations: [...probe.attestations], gap: probe.gap, expected: expectedOf(probe.gap) };
  const error = measurementError(probe, canary, obs, launch, files);
  if (error !== null) return { ...base, verdict: VERDICT.error, observed: error };
  const broken = probe.checks(canary).filter((c) => !checkHolds(c, obs, files));
  const verdict = broken.length === 0 ? (probe.gap === null ? VERDICT.pass : VERDICT.xpass) : probe.gap === null ? VERDICT.fail : VERDICT.xfail;
  return { ...base, verdict, observed: broken.length === 0 ? HELD : `se rompe: ${broken.map((c) => c.label).join('; ')}` };
}

/** una sonda que no se lanza en esta plataforma. */
export const skippedProbe = (probe: Probe, platform: string): ProbeOutcome => ({
  id: probe.id,
  title: probe.title,
  attestations: [...probe.attestations],
  gap: probe.gap,
  verdict: VERDICT.skip,
  expected: expectedOf(probe.gap),
  observed: `no aplica en ${platform}`,
});

/** lo que una sonda aporta a sus atestaciones (attestation-evidence.ts). */
export const measuredProbe = (o: ProbeOutcome): MeasuredProbe => ({
  id: o.id,
  attestations: o.attestations,
  outcome: o.verdict === VERDICT.pass || o.verdict === VERDICT.xpass ? 'held' : o.verdict === VERDICT.fail || o.verdict === VERDICT.xfail ? 'broken' : 'unmeasured',
});
