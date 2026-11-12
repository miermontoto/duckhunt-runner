// las atestaciones de un backend y su evidencia (t#440 P6): la lista de ids y de evidencias tiene que ser IDÉNTICA a la
// de runner-protocol (src/backends.ts del paquete, que añade la fase P2 del server; aquí es una copia provisional hasta
// que P4 re-vendorice el protocolo). este test fija las listas exactas para que una deriva se note, y comprueba cómo se
// resuelve el estado de cada atestación a partir de las sondas medidas.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATTESTATION_EVIDENCE,
  ATTESTATION_STATUS,
  attestationVerdicts,
  BACKEND_ATTESTATION,
  provenByConformance,
  type MeasuredProbe,
} from '../src/backends/attestation-evidence.js';

// el contrato con runner-protocol: cualquier cambio a estas listas (orden incluido) lo tiene que hacer también el
// paquete, así que un cambio aquí sin él rompe este test a propósito.
const ATTESTATION_IDS = [
  'closed_policy',
  'strict_mcp',
  'token_isolation',
  'control_private',
  'process_contained',
  'own_token_private',
  'isolated_config',
  'secret_paths',
  'own_credential_confined',
  'no_repo_exec',
  'vcs_push_deny',
  'net_policy',
  'subagent_inherit',
];
const EVIDENCE_IDS = ['structural', 'verified', 'conformance'];

test('la lista de atestaciones y de evidencias es la fijada (contrato con runner-protocol)', () => {
  assert.deepEqual(Object.values(BACKEND_ATTESTATION), ATTESTATION_IDS);
  assert.deepEqual(Object.values(ATTESTATION_EVIDENCE), EVIDENCE_IDS);
});

const measured = (attestation: string, outcome: MeasuredProbe['outcome'], id = 'p'): MeasuredProbe => ({ id, attestations: [attestation as MeasuredProbe['attestations'][number]], outcome });
const statusOf = (m: MeasuredProbe[], id: string): string => attestationVerdicts(m).find((v) => v.id === id)!.status;

test('una atestación: demostrada si todas sus sondas se cumplen; refutada si alguna se rompe; sin medir si alguna no se midió; sin sonda si ninguna la toca', () => {
  const att = BACKEND_ATTESTATION.secretPaths;
  assert.equal(statusOf([measured(att, 'held', 'a'), measured(att, 'held', 'b')], att), ATTESTATION_STATUS.proven);
  assert.equal(statusOf([measured(att, 'held', 'a'), measured(att, 'broken', 'b')], att), ATTESTATION_STATUS.refuted);
  assert.equal(statusOf([measured(att, 'held', 'a'), measured(att, 'unmeasured', 'b')], att), ATTESTATION_STATUS.unmeasured);
  assert.equal(statusOf([measured(BACKEND_ATTESTATION.netPolicy, 'held')], att), ATTESTATION_STATUS.unprobed);
});

test('attestationVerdicts recorre todas las atestaciones en su orden', () => {
  const verdicts = attestationVerdicts([]);
  assert.deepEqual(
    verdicts.map((v) => v.id),
    ATTESTATION_IDS,
  );
  assert.equal(
    verdicts.every((v) => v.status === ATTESTATION_STATUS.unprobed),
    true,
  );
});

test('provenByConformance solo da las demostradas, con evidencia conformance', () => {
  const proven = BACKEND_ATTESTATION.closedPolicy;
  const broken = BACKEND_ATTESTATION.secretPaths;
  const out = provenByConformance(attestationVerdicts([measured(proven, 'held'), measured(broken, 'broken')]));
  assert.deepEqual(out, [{ id: proven, by: ATTESTATION_EVIDENCE.conformance }]);
});
