// protocolo vendorizado (@duckhunt/runner-protocol, t#495 M3): el mismo candado que el test del server, sobre lo
// que copió scripts/vendor-protocol.mjs. los fixtures de test/fixtures son los de su manifiesto (ni uno más ni uno
// menos), el conjunto es el que versions.json fijó para la versión vendorizada, esa versión llega al mínimo que
// este daemon entiende, y los módulos de src/vendor/runner-protocol son los que se copiaron: un retoque a mano se
// nota (el cambio se hace en duckhunt y se vuelve a vendorizar).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';

// versión mínima del protocolo que este daemon entiende: vendorizar una anterior es un error.
const MIN_PROTOCOL = '0.5.0';
const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const VENDOR = new URL('../../src/vendor/runner-protocol/', import.meta.url);
// los que cubre el manifiesto del paquete (su src/fixtures.ts::FIXTURE_SUBDIRS).
const FIXTURE_SUBDIRS: readonly string[] = ['claim-kits', 'claims', 'toolset-v1', 'toolset-v1-aws-default', 'v0', 'claims-browser'];
const RECORD_FILE = 'vendor.json';
const MODULE_EXT = '.ts';

interface Manifest {
  version: string;
  files: Record<string, string>;
}

interface VendorRecord {
  version: string;
  contentHash: string;
  commit: string | null;
  files: Record<string, string>;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const readJson = <T>(file: string, base: URL): T => JSON.parse(fs.readFileSync(new URL(file, base), 'utf8')) as T;
// el mismo cálculo que src/fixtures.ts::contentHash del paquete.
const contentHash = (files: Readonly<Record<string, string>>): string =>
  sha256(JSON.stringify(Object.keys(files).sort().map((file) => [file, files[file]])));
// x.y.z numérico: true si `v` es `min` o posterior.
const atLeast = (v: string, min: string): boolean => {
  const [a, b] = [v, min].map((s) => s.split('.').map(Number));
  const i = a!.findIndex((n, k) => n !== b![k]);
  return i === -1 || a![i]! > b![i]!;
};

const manifest = readJson<Manifest>('manifest.json', FIXTURES);
const versions = readJson<Record<string, string>>('versions.json', FIXTURES);
const record = readJson<VendorRecord>(RECORD_FILE, VENDOR);

test('los fixtures son los del manifiesto vendorizado, ni uno más ni uno menos', () => {
  const onDisk = Object.fromEntries(
    FIXTURE_SUBDIRS.flatMap((dir) =>
      fs
        .readdirSync(new URL(`${dir}/`, FIXTURES))
        .sort()
        .map((file) => [`${dir}/${file}`, sha256(fs.readFileSync(new URL(`${dir}/${file}`, FIXTURES)))]),
    ),
  );
  assert.deepEqual(onDisk, manifest.files, 'test/fixtures no es lo vendorizado: npm run vendor:protocol');
});

test('la versión vendorizada llega al mínimo y su conjunto es el que versions.json fijó para ella', () => {
  assert.equal(manifest.version, record.version, 'el manifiesto y vendor.json son de versiones distintas');
  assert.ok(atLeast(record.version, MIN_PROTOCOL), `protocolo ${record.version} anterior al mínimo ${MIN_PROTOCOL}`);
  const hash = contentHash(manifest.files);
  assert.equal(versions[record.version], hash, `los fixtures no son los que salieron con ${record.version}`);
  assert.equal(record.contentHash, hash);
});

test('los módulos vendorizados son los copiados: un retoque a mano se nota', () => {
  const modules = fs.readdirSync(VENDOR).filter((f) => f.endsWith(MODULE_EXT)).sort();
  assert.deepEqual(modules, Object.keys(record.files).sort(), 'módulos de más o de menos en src/vendor/runner-protocol');
  modules.forEach((m) => assert.equal(sha256(fs.readFileSync(new URL(m, VENDOR))), record.files[m], `${m} no es el vendorizado: cámbialo en duckhunt y vuelve a vendorizar`));
});
