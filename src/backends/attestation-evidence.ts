// las atestaciones de un backend y su evidencia (t#440 P6): qué garantía de seguridad aplica un cli de agente y con qué
// se demostró para SU versión exacta. el arnés de conformidad (src/conformance/) mide sondas contra el cli instalado;
// aquí se decide qué atestaciones quedan demostradas por esas medidas, que es lo que un driver anunciará (P7/P8).
// decisiones:
// - BACKEND_ATTESTATION y ATTESTATION_EVIDENCE tienen que ser IDÉNTICOS a los de runner-protocol (src/backends.ts del
//   paquete, que añade la fase P2 del server en paralelo): mismos ids, mismos valores, mismo orden. es una copia
//   provisional; al re-vendorizar el protocolo en P4 pasan a importarse de src/vendor/runner-protocol y aquí queda solo
//   la lógica de evidencia. test/attestation-evidence.test.ts fija las listas exactas para que una deriva se note.
// - una atestación queda demostrada por conformidad solo si TODAS sus sondas pasan. una sola que filtra (o un hueco
//   conocido que sigue abierto) la refuta; una sonda que no se pudo medir la deja en error, nunca demostrada.
// - sin sonda no hay evidencia de conformidad: «sin sonda», que para el server es lo mismo que no atestar.

/** garantías de seguridad que un backend demuestra para su versión (runner-protocol, t#440 P2). */
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

/** cómo quedó una atestación tras medir sus sondas. */
export const ATTESTATION_STATUS = {
  // todas sus sondas pasan: demostrada por conformidad.
  proven: 'proven',
  // alguna filtra (también un hueco conocido que sigue abierto).
  refuted: 'refuted',
  // ninguna filtra pero alguna no se pudo medir.
  unmeasured: 'unmeasured',
  // ninguna sonda la mide.
  unprobed: 'unprobed',
} as const;
export type AttestationStatus = (typeof ATTESTATION_STATUS)[keyof typeof ATTESTATION_STATUS];

/** lo que una sonda medida aporta a sus atestaciones. */
export interface MeasuredProbe {
  id: string;
  attestations: readonly BackendAttestation[];
  // la garantía se cumplió (pass o xpass), se rompió (fail o xfail) o no se pudo medir (error, skip).
  outcome: 'held' | 'broken' | 'unmeasured';
}

/** una atestación, cómo quedó y qué sondas la decidieron. */
export interface AttestationVerdict {
  id: BackendAttestation;
  status: AttestationStatus;
  probes: string[];
}

/** el estado de cada atestación según las sondas medidas (ver cabecera), en el orden de BACKEND_ATTESTATION. */
export function attestationVerdicts(measured: readonly MeasuredProbe[]): AttestationVerdict[] {
  return Object.values(BACKEND_ATTESTATION).map((id) => {
    const mine = measured.filter((p) => p.attestations.includes(id));
    const status =
      mine.length === 0
        ? ATTESTATION_STATUS.unprobed
        : mine.some((p) => p.outcome === 'broken')
          ? ATTESTATION_STATUS.refuted
          : mine.some((p) => p.outcome === 'unmeasured')
            ? ATTESTATION_STATUS.unmeasured
            : ATTESTATION_STATUS.proven;
    return { id, status, probes: mine.map((p) => p.id) };
  });
}

/** las atestaciones demostradas por conformidad, con su evidencia: lo que un driver puede anunciar para esa versión. */
export const provenByConformance = (verdicts: readonly AttestationVerdict[]): { id: BackendAttestation; by: AttestationEvidence }[] =>
  verdicts.filter((v) => v.status === ATTESTATION_STATUS.proven).map((v) => ({ id: v.id, by: ATTESTATION_EVIDENCE.conformance }));
