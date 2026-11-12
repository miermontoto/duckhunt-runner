// backends de agente de una máquina (t#440): la dimensión que separa el cable del cli concreto. una máquina puede
// ofrecer varios (claude code hoy; codex y los de acp detrás) y cada run corre en UNO, fijado en su primer claim. por
// ahora (P2) son constantes y funciones puras que el server usa dormidas: el claim aún no trae `backends` (llega en P4)
// y una máquina que no los anuncia es claude_code con sus capabilities planas, exactamente como antes.
// decisiones:
// - capabilities de backend (BACKEND_SCOPED_CAPABILITIES): las que dependen del cli que corre el run (prompt, la shell
//   de lectura, el modelo, la autonomía, volver atrás…). el resto (events, checkout, repo_edit, logout, toolset_v1…)
//   son de la máquina y salen siempre de las planas. effectiveCapabilities compone las dos: con backends anunciados,
//   las de backend salen SOLO del anuncio del backend del run (las planas pueden ser las de claude); sin backends
//   anunciados, claude_code son exactamente las planas y cualquier otro backend no tiene ninguna (sin `prompt`: no
//   recibe nada). seed_budget_tokens y slash_commands solo existen dentro de un anuncio (BACKEND_CAPABILITY).
// - atestaciones (BACKEND_ATTESTATION): una garantía de seguridad que el backend aplica con un mecanismo con nombre y
//   con evidencia para SU versión exacta (ATTESTATION_EVIDENCE). una clase de run solo va a un backend no-claude que
//   atesta TODO lo que la clase necesita (RUN_CLASS_ATTESTATIONS) y, una investigación, con un tope de gasto
//   (RUN_CLASS_ANY_CAPABILITY). claude_code no se evalúa: su kit es el de siempre y su interruptor, el de los agentes.
//   lo que no se atesta se ve como «sin soporte», nunca como una garantía más floja en silencio.
// - un backend con `unsupported` (deriva del esquema, versión sin verificar) se anuncia para que la persona lo vea,
//   pero no ofrece nada: ni capabilities ni clases.
// non-goals: validar el anuncio (cada lado con lo suyo: el server en queries/runner-presence.ts) y decidir qué backend
// toma un run (la política del server: queries/runners.ts::resolveRunBackend, con la admisión de la instancia).

import { RUNNER_CAPABILITY, type RunnerCapability } from './capabilities.js';

/** backends de agente que conoce el protocolo (un daemon más nuevo puede anunciar otros: su id es un string). */
export const RUNNER_BACKEND = {
  claudeCode: 'claude_code',
  codex: 'codex',
  opencode: 'opencode',
} as const;
export type RunnerBackend = (typeof RUNNER_BACKEND)[keyof typeof RUNNER_BACKEND];

/** capabilities que solo existen dentro del anuncio de un backend (nunca planas). */
export const BACKEND_CAPABILITY = {
  // aplica un tope de tokens a una investigación (el equivalente de seed_budget para quien no reporta usd; P11).
  seedBudgetTokens: 'seed_budget_tokens',
  // sube su catálogo de slash commands (P4: el catálogo por backend).
  slashCommands: 'slash_commands',
} as const;
export type BackendCapability = RunnerCapability | (typeof BACKEND_CAPABILITY)[keyof typeof BACKEND_CAPABILITY];

/** las capabilities que dependen del backend del run (ver cabecera); las demás son de la máquina. */
export const BACKEND_SCOPED_CAPABILITIES: readonly BackendCapability[] = [
  RUNNER_CAPABILITY.prompt,
  RUNNER_CAPABILITY.readShell,
  RUNNER_CAPABILITY.nativeMemory,
  RUNNER_CAPABILITY.secretPaths,
  RUNNER_CAPABILITY.seedBudget,
  BACKEND_CAPABILITY.seedBudgetTokens,
  RUNNER_CAPABILITY.model,
  RUNNER_CAPABILITY.autonomy,
  RUNNER_CAPABILITY.autonomyBypass,
  RUNNER_CAPABILITY.rewind,
  RUNNER_CAPABILITY.rewindFiles,
  RUNNER_CAPABILITY.multiRepo,
  RUNNER_CAPABILITY.extraRepoChanges,
  RUNNER_CAPABILITY.subagents,
  RUNNER_CAPABILITY.liveInput,
  RUNNER_CAPABILITY.liveTurns,
  RUNNER_CAPABILITY.aws,
  RUNNER_CAPABILITY.browser,
  BACKEND_CAPABILITY.slashCommands,
];

/** garantías de seguridad que un backend demuestra para su versión (ver cabecera y el modelo de seguridad de t#440). */
export const BACKEND_ATTESTATION = {
  // política cerrada y explícita en cada arranque: nunca un bypass total.
  closedPolicy: 'closed_policy',
  // solo carga los servidores mcp que le da el daemon.
  strictMcp: 'strict_mcp',
  // el token per-run no es alcanzable desde otro run.
  tokenIsolation: 'token_isolation',
  // el canal de control y de aprobaciones es privado del segmento.
  controlPrivate: 'control_private',
  // un proceso privado por segmento, en su grupo, que muere entero al cancelar.
  processContained: 'process_contained',
  // el token per-run nunca en argv, env ni en reposo en un sitio compartido.
  ownTokenPrivate: 'own_token_private',
  // su config es la que escribe el daemon (ni la del usuario ni la del proyecto la amplían).
  isolatedConfig: 'isolated_config',
  // las rutas de secretos son ilegibles.
  secretPaths: 'secret_paths',
  // sus propias credenciales no salen de su home.
  ownCredentialConfined: 'own_credential_confined',
  // un run de lectura nunca ejecuta código, config ni hooks del repo.
  noRepoExec: 'no_repo_exec',
  // no puede hacer push.
  vcsPushDeny: 'vcs_push_deny',
  // sin red ni tools alojadas cuando el run no navega.
  netPolicy: 'net_policy',
  // sus subagentes heredan el sandbox y la política.
  subagentInherit: 'subagent_inherit',
} as const;
export type BackendAttestation = (typeof BACKEND_ATTESTATION)[keyof typeof BACKEND_ATTESTATION];

/** de dónde sale la evidencia de una atestación: estructural, la tabla VERIFIED por versión exacta o conformidad local. */
export const ATTESTATION_EVIDENCE = {
  structural: 'structural',
  verified: 'verified',
  conformance: 'conformance',
} as const;
export type AttestationEvidence = (typeof ATTESTATION_EVIDENCE)[keyof typeof ATTESTATION_EVIDENCE];

/** clase de un run a efectos de backend: quién hay detrás y si edita; una investigación es su propia clase. */
export const RUN_CLASS = {
  attendedEdit: 'attended_edit',
  attendedRead: 'attended_read',
  unattendedRead: 'unattended_read',
  unattendedEdit: 'unattended_edit',
  template: 'template',
} as const;
export type RunClass = (typeof RUN_CLASS)[keyof typeof RUN_CLASS];

// lo que necesita toda clase: política cerrada, mcp estricto, token aislado, control privado y procesos contenidos.
const BASE_ATTESTATIONS: readonly BackendAttestation[] = [
  BACKEND_ATTESTATION.closedPolicy,
  BACKEND_ATTESTATION.strictMcp,
  BACKEND_ATTESTATION.tokenIsolation,
  BACKEND_ATTESTATION.controlPrivate,
  BACKEND_ATTESTATION.processContained,
];
// la lectura además no ejecuta nada del repo y no alcanza secretos ni credenciales.
const READ_ATTESTATIONS: readonly BackendAttestation[] = [
  ...BASE_ATTESTATIONS,
  BACKEND_ATTESTATION.ownTokenPrivate,
  BACKEND_ATTESTATION.isolatedConfig,
  BACKEND_ATTESTATION.secretPaths,
  BACKEND_ATTESTATION.ownCredentialConfined,
  BACKEND_ATTESTATION.noRepoExec,
];

/** lo que un backend no-claude tiene que atestar para recibir cada clase (claude_code no se evalúa). */
export const RUN_CLASS_ATTESTATIONS: Readonly<Record<RunClass, readonly BackendAttestation[]>> = {
  [RUN_CLASS.attendedEdit]: BASE_ATTESTATIONS,
  [RUN_CLASS.attendedRead]: READ_ATTESTATIONS,
  [RUN_CLASS.unattendedRead]: READ_ATTESTATIONS,
  [RUN_CLASS.unattendedEdit]: [
    ...BASE_ATTESTATIONS,
    BACKEND_ATTESTATION.ownTokenPrivate,
    BACKEND_ATTESTATION.secretPaths,
    BACKEND_ATTESTATION.ownCredentialConfined,
    BACKEND_ATTESTATION.vcsPushDeny,
  ],
  [RUN_CLASS.template]: [...READ_ATTESTATIONS, BACKEND_ATTESTATION.netPolicy],
};

/** además de las atestaciones, una de estas capabilities por clase (una investigación: un tope de gasto, en usd o en tokens). */
export const RUN_CLASS_ANY_CAPABILITY: Readonly<Partial<Record<RunClass, readonly BackendCapability[]>>> = {
  [RUN_CLASS.template]: [RUNNER_CAPABILITY.seedBudget, BACKEND_CAPABILITY.seedBudgetTokens],
};

/** una atestación anunciada y su evidencia. */
export interface BackendAttestationClaim {
  id: BackendAttestation;
  by: AttestationEvidence;
}

/** lo que una máquina anuncia de cada backend que tiene (el cable llega en P4). */
export interface BackendAnnounce {
  id: string;
  version: string | null;
  // sus capabilities de backend (BACKEND_SCOPED_CAPABILITIES); otras que traiga no cuentan.
  capabilities: readonly string[];
  attestations: readonly BackendAttestationClaim[];
  // por qué no ofrece nada (deriva del esquema, versión sin verificar…); ausente = soportado.
  unsupported?: string;
  // los modelos que acepta (P12); ausente = el suyo.
  models?: readonly string[];
}

// backends anunciados por máquina, atestaciones y modelos por backend, y el largo de un modelo y de un motivo: presencia,
// lo que pasa se recorta y nunca tumba el claim.
export const RUNNER_BACKENDS_MAX = 8;
export const BACKEND_ATTESTATIONS_MAX = 32;
export const BACKEND_MODELS_MAX = 64;
export const BACKEND_MODEL_MAX_CHARS = 120;
export const BACKEND_UNSUPPORTED_MAX_CHARS = 200;

const SCOPED: ReadonlySet<string> = new Set(BACKEND_SCOPED_CAPABILITIES);

/** ¿ofrece algo este backend? (no anuncia `unsupported`). */
export const backendOffered = (backend: BackendAnnounce): boolean => backend.unsupported === undefined;

/** el anuncio del backend `id` si la máquina lo ofrece; null si no lo anuncia o no lo soporta. */
export const offeredBackend = (backends: readonly BackendAnnounce[], id: string): BackendAnnounce | null =>
  backends.find((b) => b.id === id && backendOffered(b)) ?? null;

/**
 * las capabilities de la máquina para un run en `backend` (ver cabecera): las de la máquina más las de ese backend. sin
 * backends anunciados, claude_code = exactamente `flat` y otro backend, solo las de la máquina.
 */
export function effectiveCapabilities(flat: readonly string[], backends: readonly BackendAnnounce[], backend: string): readonly string[] {
  if (backends.length === 0) return backend === RUNNER_BACKEND.claudeCode ? flat : flat.filter((c) => !SCOPED.has(c));
  const own = offeredBackend(backends, backend)?.capabilities.filter((c) => SCOPED.has(c)) ?? [];
  return [...flat.filter((c) => !SCOPED.has(c)), ...own];
}

/** ¿recibe trabajo la máquina en algún backend? sustituye a todo check plano de `prompt` (sin backends, ese mismo). */
export function runnerOffersPrompt(flat: readonly string[], backends: readonly BackendAnnounce[]): boolean {
  if (backends.length === 0) return flat.includes(RUNNER_CAPABILITY.prompt);
  return backends.some((b) => backendOffered(b) && b.capabilities.includes(RUNNER_CAPABILITY.prompt));
}

/** ¿atesta este backend todo lo que pide la clase (y su capability alternativa)? claude_code no se evalúa: sí. */
export function backendAttestsClass(backend: BackendAnnounce, runClass: RunClass): boolean {
  if (backend.id === RUNNER_BACKEND.claudeCode) return true;
  const attested = new Set<string>(backend.attestations.map((a) => a.id));
  const anyOf = RUN_CLASS_ANY_CAPABILITY[runClass];
  return RUN_CLASS_ATTESTATIONS[runClass].every((a) => attested.has(a)) && (anyOf === undefined || anyOf.some((c) => backend.capabilities.includes(c)));
}
