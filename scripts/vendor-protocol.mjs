// vendoriza @duckhunt/runner-protocol (t#495, M3): el cable que comparten duckhunt y este daemon, copiado de un
// checkout de duckhunt sin depender de npm (el tarball sigue con `dependencies: {}`). antes de copiar verifica el
// paquete como su propio test: cada fixture con el sha256 de su manifiesto (ni uno más ni uno menos), la versión
// del manifiesto igual a la del package y el conjunto entero igual al que versions.json fijó para esa versión. un
// paquete con cambios sin commitear no se vendoriza: lo copiado tiene que poder señalarse por commit.
// copia:
// - los módulos del barrel a src/vendor/runner-protocol/ (fixtures.ts no: es tooling de los tests de duckhunt).
// - los fixtures, el manifiesto y versions.json a test/fixtures/ (los que leen los tests de siempre).
// - src/vendor/runner-protocol/vendor.json: versión, hash del conjunto, commit de origen y el sha256 de cada
//   módulo copiado (test/runner-protocol.test.ts lo comprueba: un retoque a mano se nota).
// uso: npm run vendor:protocol (RUNNER_PROTOCOL_DIR=<checkout>/packages/runner-protocol; por defecto el de
// ../duckhunt).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.resolve(process.env.RUNNER_PROTOCOL_DIR ?? path.join(ROOT, '..', 'duckhunt', 'packages', 'runner-protocol'));
const VENDOR_DIR = path.join(ROOT, 'src', 'vendor', 'runner-protocol');
const FIXTURES_DEST = path.join(ROOT, 'test', 'fixtures');
// módulos del barrel (src/index.ts del paquete y lo que reexporta).
const MODULES = ['index.ts', 'aws.ts', 'capabilities.ts', 'claim.ts', 'errors.ts', 'events.ts', 'limits.ts', 'toolset.ts', 'v0.ts'];
// lo mismo que cubre el manifiesto del paquete (src/fixtures.ts::FIXTURE_SUBDIRS).
const FIXTURE_SUBDIRS = ['claim-kits', 'claims', 'toolset-v1', 'toolset-v1-aws-default', 'v0'];
const FIXTURE_META = ['manifest.json', 'versions.json'];
const RECORD_FILE = 'vendor.json';
const JSON_INDENT = 2;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
// el mismo cálculo que src/fixtures.ts::contentHash del paquete.
const contentHash = (files) => sha256(JSON.stringify(Object.keys(files).sort().map((file) => [file, files[file]])));
const fail = (msg) => {
  console.error(`vendor:protocol: ${msg}`);
  process.exit(1);
};
const git = (...args) => execFileSync('git', ['-C', SOURCE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

if (!existsSync(path.join(SOURCE, 'package.json'))) fail(`no hay paquete en ${SOURCE} (RUNNER_PROTOCOL_DIR)`);
const version = readJson(path.join(SOURCE, 'package.json')).version;
const fixturesDir = path.join(SOURCE, 'fixtures');
const manifest = readJson(path.join(fixturesDir, 'manifest.json'));
const versions = readJson(path.join(fixturesDir, 'versions.json'));
const onDisk = Object.fromEntries(
  FIXTURE_SUBDIRS.flatMap((dir) =>
    readdirSync(path.join(fixturesDir, dir))
      .sort()
      .map((file) => [`${dir}/${file}`, sha256(readFileSync(path.join(fixturesDir, dir, file)))]),
  ),
);
const mismatched = [...new Set([...Object.keys(onDisk), ...Object.keys(manifest.files)])].filter((f) => onDisk[f] !== manifest.files[f]);
if (mismatched.length > 0) fail(`fixtures que no son los del manifiesto: ${mismatched.join(', ')}`);
if (manifest.version !== version) fail(`el manifiesto es de la ${manifest.version} y el paquete de la ${version}`);
const hash = contentHash(manifest.files);
if (versions[version] !== hash) fail(`los fixtures no son los que salieron con ${version} (versions.json): ${hash}`);

// commit de origen: el último que tocó el paquete (re-vendorizar el mismo paquete desde un duckhunt más nuevo no
// cambia nada); null fuera de git. con cambios sin commitear en el paquete, no se vendoriza.
const commit = (() => {
  try {
    return git('log', '-1', '--format=%H', '--', '.') || null;
  } catch {
    return null;
  }
})();
if (commit !== null && git('status', '--porcelain', '--', '.') !== '') fail(`${SOURCE} tiene cambios sin commitear`);

rmSync(VENDOR_DIR, { recursive: true, force: true });
mkdirSync(VENDOR_DIR, { recursive: true });
MODULES.forEach((m) => cpSync(path.join(SOURCE, 'src', m), path.join(VENDOR_DIR, m)));
FIXTURE_SUBDIRS.forEach((dir) => {
  rmSync(path.join(FIXTURES_DEST, dir), { recursive: true, force: true });
  cpSync(path.join(fixturesDir, dir), path.join(FIXTURES_DEST, dir), { recursive: true });
});
FIXTURE_META.forEach((f) => cpSync(path.join(fixturesDir, f), path.join(FIXTURES_DEST, f)));
const record = {
  version,
  contentHash: hash,
  commit,
  files: Object.fromEntries(MODULES.map((m) => [m, sha256(readFileSync(path.join(VENDOR_DIR, m)))])),
};
writeFileSync(path.join(VENDOR_DIR, RECORD_FILE), `${JSON.stringify(record, null, JSON_INDENT)}\n`);
console.log(`vendor:protocol: ${version} (${hash.slice(0, 12)}${commit ? `, ${commit.slice(0, 8)}` : ''}) → src/vendor/runner-protocol + test/fixtures`);
