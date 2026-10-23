// mcp-config de los runs (0.10.2, t#465): bajo el estado del daemon, 0600 en un directorio 0700, sin
// pisar nada que ya estuviera, recogidos al arrancar, y su directorio negado a Read en todo kit
// (lectura, edición, reglas heredadas con o sin skip-permissions, y todos los claims reales del server).
// 0.11.0: el barrido único de los que dejaban en el tmpdir los daemons < 0.10.2.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildClaudeArgs } from '../src/claude-args.js';
import { parseClaim } from '../src/claim.js';
import { OPTIONAL_FLAGS } from '../src/claude.js';
import { LEGACY_PLATFORM_ID, runConfigDir } from '../src/paths.js';
import { clearLegacyTmpConfigs, clearRunMcpConfigs, readDenyRule, runConfigDeny, writeRunMcpConfig } from '../src/run-mcp-config.js';

const MODE_BITS = 0o777;
const mcp = { serverName: 'duckhunt', url: 'https://duckhunt.info/mcp', token: 'dho_secret', expiresAt: 1 };
let home = '';
let prevHome: string | undefined;

before(() => {
  prevHome = process.env.DUCKHUNT_RUNNER_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-home-')));
  process.env.DUCKHUNT_RUNNER_HOME = home;
});

after(() => {
  if (prevHome === undefined) delete process.env.DUCKHUNT_RUNNER_HOME;
  else process.env.DUCKHUNT_RUNNER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('el mcp-config va a <runnerHome>/run-config: fichero 0600 en un directorio 0700, con el token del run', () => {
  const file = writeRunMcpConfig('88', mcp, LEGACY_PLATFORM_ID);
  const dir = path.join(home, 'run-config');
  assert.equal(path.dirname(file), dir);
  assert.match(path.basename(file), /^mcp-88-[0-9a-f]{8}\.json$/);
  assert.equal(fs.statSync(dir).mode & MODE_BITS, 0o700);
  assert.equal(fs.statSync(file).mode & MODE_BITS, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    mcpServers: { duckhunt: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer dho_secret' } } },
  });
  assert.notEqual(writeRunMcpConfig('88', mcp, LEGACY_PLATFORM_ID), file, 'cada segmento, su fichero');
});

test('un directorio que ya existía abierto se cierra a 0700', () => {
  const dir = path.join(home, 'run-config');
  fs.chmodSync(dir, 0o755);
  assert.equal(runConfigDir(LEGACY_PLATFORM_ID), dir);
  assert.equal(fs.statSync(dir).mode & MODE_BITS, 0o700);
});

test('al arrancar se borran los mcp-config que dejó un daemon muerto, y nada más', () => {
  const dir = runConfigDir(LEGACY_PLATFORM_ID);
  writeRunMcpConfig('5', mcp, LEGACY_PLATFORM_ID);
  fs.writeFileSync(path.join(dir, 'notas.txt'), 'del usuario');
  assert.ok(clearRunMcpConfigs(LEGACY_PLATFORM_ID) >= 1);
  assert.deepEqual(fs.readdirSync(dir), ['notas.txt']);
  assert.equal(clearRunMcpConfigs(LEGACY_PLATFORM_ID), 0);
});

test('deny de Read del directorio por su ruta y su realpath; una ruta que no cabe en una regla no arranca', () => {
  const dir = runConfigDir(LEGACY_PLATFORM_ID);
  assert.deepEqual(runConfigDeny(dir), [`Read(/${dir}/**)`]);
  assert.ok(runConfigDeny(dir)[0]!.startsWith('Read(//'), 'ruta absoluta del sistema, no relativa al proyecto');
  // un estado del runner enlazado (dotfiles): las dos rutas.
  const linked = path.join(home, 'linked-home');
  fs.symlinkSync(home, linked);
  assert.deepEqual(runConfigDeny(path.join(linked, 'run-config')), [`Read(/${linked}/run-config/**)`, `Read(/${dir}/**)`]);
  const comma = path.join(home, 'a,b');
  fs.mkdirSync(comma);
  assert.throws(() => runConfigDeny(comma), /no cabe en una regla de permisos/);
  const glob = path.join(home, 'x[1]');
  fs.mkdirSync(glob);
  assert.throws(() => runConfigDeny(glob), /no cabe en una regla de permisos/);
});

test('el deny del directorio va en TODO argv (lectura, edición, reglas, skip-permissions, claims del server); sin él no se lanza', () => {
  const deny = runConfigDeny(runConfigDir(LEGACY_PLATFORM_ID));
  const fixtures = ['claims', 'claim-kits'].flatMap((dir) => {
    const url = new URL(`../../test/fixtures/${dir}/`, import.meta.url);
    return fs
      .readdirSync(url)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(new URL(f, url), 'utf8')) as Record<string, unknown>);
  });
  const rule = { ...fixtures[0]!, run: { ...(fixtures[0]!.run as object), kind: 'investigate', profile: null }, tools: { allowed: ['Read', 'Bash'], disallowed: [] }, permissionMode: 'default' };
  const claims = [...fixtures, rule].map((raw) => parseClaim(raw, { canBypass: true }));
  const inputs = claims.flatMap((claim) => [false, true].map((skipPermissions) => ({ claim, skipPermissions })));
  inputs.forEach(({ claim, skipPermissions }) => {
    const args = buildClaudeArgs({
      claim,
      prompt: 'p',
      mcpConfigFile: path.join(runConfigDir(LEGACY_PLATFORM_ID), 'mcp-1-abcd.json'),
      supported: new Set(OPTIONAL_FLAGS),
      resumeSessionId: null,
      skipPermissions,
      payingWithApiKey: false,
      runConfigDeny: deny,
      withoutShell: skipPermissions,
      permissionPromptTool: true,
    });
    const disallowed = args[args.indexOf('--disallowedTools') + 1]!.split(',');
    assert.ok(deny.every((d) => disallowed.includes(d)), `${claim.run.kind}/${claim.run.profile}: sin el deny del directorio`);
  });
  const claim = claims[0]!;
  const base = { claim, prompt: 'p', mcpConfigFile: '/m.json', resumeSessionId: null, skipPermissions: false, payingWithApiKey: false };
  assert.throws(() => buildClaudeArgs({ ...base, supported: new Set(OPTIONAL_FLAGS), runConfigDeny: [] }), /directorio de configs de run/);
  // un cli sin --disallowedTools no puede llevarlo: tampoco un run de reglas (que antes no lo exigía).
  const noDeny = new Set(OPTIONAL_FLAGS.filter((f) => f !== '--disallowedTools'));
  assert.throws(() => buildClaudeArgs({ ...base, claim: claims.at(-1)!, supported: noDeny, runConfigDeny: deny }), /--disallowedTools/);
});

test('al arrancar se barren los mcp-config que los daemons < 0.10.2 dejaban en el tmpdir: solo los suyos y ficheros', () => {
  const tmp = fs.mkdtempSync(path.join(home, 'tmp-'));
  const legacy = ['duckhunt-runner-88-0a1b2c3d.json', 'duckhunt-runner-7-ffffffff.json'];
  legacy.forEach((name) => fs.writeFileSync(path.join(tmp, name), '{"token":"dho_viejo"}'));
  // lo que no es suyo se queda: otro nombre, un directorio y un symlink con el nombre de un config.
  fs.writeFileSync(path.join(tmp, 'duckhunt-runner-x.json'), 'otro');
  fs.writeFileSync(path.join(tmp, 'duckhunt-runner-88-0a1b2c3d.json.bak'), 'otro');
  fs.mkdirSync(path.join(tmp, 'duckhunt-runner-9-00000000.json'));
  fs.symlinkSync(path.join(tmp, 'duckhunt-runner-x.json'), path.join(tmp, 'duckhunt-runner-10-11111111.json'));
  assert.equal(clearLegacyTmpConfigs(tmp), 2);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['duckhunt-runner-10-11111111.json', 'duckhunt-runner-88-0a1b2c3d.json.bak', 'duckhunt-runner-9-00000000.json', 'duckhunt-runner-x.json']);
  // los de otro usuario (otro uid) tampoco.
  fs.writeFileSync(path.join(tmp, legacy[0]!), '{}');
  assert.equal(clearLegacyTmpConfigs(tmp, (process.getuid?.() ?? 0) + 1), 0);
  assert.equal(clearLegacyTmpConfigs(tmp), 1);
});

test('readDenyRule: ruta absoluta del sistema, `/**` en directorios y null si no cabe en una regla', () => {
  assert.equal(readDenyRule('/home/u/.duckhunt-runner.json', false), 'Read(//home/u/.duckhunt-runner.json)');
  assert.equal(readDenyRule('/home/u/.duckhunt-runner/logs', true), 'Read(//home/u/.duckhunt-runner/logs/**)');
  assert.equal(readDenyRule('relativa/x', false), null);
  assert.equal(readDenyRule('/home/u/a,b', false), null);
  assert.equal(readDenyRule('/home/u/x*', true), null);
});
