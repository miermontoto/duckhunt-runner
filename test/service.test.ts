// el servicio del daemon (t#660), las cuentas aws que propone `setup` y sus argumentos: lo que se escribe en la unidad de systemd y en el
// LaunchAgent (comando fijado a la versión, entorno mínimo, exit 78 sin reinicio, escapes) y cómo se leen los flags.
// instalar de verdad (systemctl, launchctl) no se prueba aquí.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { awsEntryOf, planAwsAccounts } from '../src/aws-discover.js';
import { daemonCommand, launchdPlist, serviceEnv, systemdUnit } from '../src/service.js';
import { defaultCodeDir, parseSetupArgs } from '../src/setup.js';

test('lanzado con npx el servicio fija la versión; instalado, su propio index.js con este node', () => {
  const node = '/opt/node/bin/node';
  assert.deepEqual(daemonCommand('/home/u/.npm/_npx/ab12/node_modules/.bin/duckhunt-runner', node, '0.28.0').slice(1), ['--yes', 'duckhunt-runner@0.28.0', 'start']);
  assert.deepEqual(daemonCommand('/home/u/.cache/pnpm/dlx/xyz/node_modules/duckhunt-runner/dist/index.js', node, '0.28.0').slice(1), ['--yes', 'duckhunt-runner@0.28.0', 'start']);
  assert.deepEqual(daemonCommand('/usr/lib/node_modules/duckhunt-runner/dist/index.js', node, '0.28.0'), [node, '/usr/lib/node_modules/duckhunt-runner/dist/index.js', 'start']);
  assert.throws(() => daemonCommand('/home/u/.npm/_npx/ab12/x.js', node, null), /sin versión/);
});

test('el entorno del servicio: solo las claves que necesita, con las rutas absolutas', () => {
  const env = serviceEnv({ PATH: '/usr/bin:/bin', DUCKHUNT_RUNNER_CONFIG: 'rel/runner.json', AWS_SECRET_ACCESS_KEY: 'x', HOME: '/home/u' });
  assert.deepEqual(env, { PATH: '/usr/bin:/bin', DUCKHUNT_RUNNER_CONFIG: path.resolve('rel/runner.json') });
});

test('la unidad de systemd: ExecStart entrecomillado, su entorno, reinicio salvo con 78', () => {
  const unit = systemdUnit(['/opt/node/bin/npx', '--yes', 'duckhunt-runner@0.28.0', 'start'], { PATH: '/a b:/c%d', X: 'cuesta $5' });
  assert.match(unit, /^ExecStart="\/opt\/node\/bin\/npx" "--yes" "duckhunt-runner@0\.28\.0" "start"$/m);
  assert.match(unit, /^Environment="PATH=\/a b:\/c%%d"$/m, '% escapado como especificador');
  assert.match(unit, /^Environment="X=cuesta \$5"$/m, 'en Environment= no se expande $');
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartPreventExitStatus=78$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.equal(systemdUnit(['/x/$HOME'], {}).match(/^ExecStart=.*$/m)![0], 'ExecStart="/x/$$HOME"', 'en ExecStart sí: $$');
});

test('el LaunchAgent: argumentos, entorno y logs escapados como xml', () => {
  const plist = launchdPlist(['/opt/node/bin/node', '/a&b/index.js', 'start'], { PATH: '/usr/bin' }, '/Users/u/.duckhunt-runner/daemon.log');
  assert.match(plist, /<string>info\.duckhunt\.runner<\/string>/);
  assert.match(plist, /<string>\/a&#38;b\/index\.js<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\n\s*<string>\/usr\/bin<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\n\s*<string>\/Users\/u\/\.duckhunt-runner\/daemon\.log<\/string>/);
});

test('setup: instancia y nombre como los de login, flags con su valor y lo que no casa, con el uso', () => {
  assert.deepEqual(parseSetupArgs([]), { baseUrl: 'https://duckhunt.info', yes: false });
  assert.deepEqual(parseSetupArgs(['portatil']), { baseUrl: 'https://duckhunt.info', yes: false, name: 'portatil' });
  assert.deepEqual(parseSetupArgs(['dh.example.com/', '--name', 'fa', '--repos', '~/dev', '--service', '-y', '--no-browser']), {
    baseUrl: 'https://dh.example.com',
    yes: true,
    name: 'fa',
    reposDir: '~/dev',
    service: true,
  });
  assert.deepEqual(parseSetupArgs(['--no-repos', '--no-service', '--no-aws']), { baseUrl: 'https://duckhunt.info', yes: false, reposDir: null, aws: false, service: false });
  assert.throws(() => parseSetupArgs(['--name']), /uso: duckhunt-runner setup/);
  assert.throws(() => parseSetupArgs(['--bogus']), /uso: duckhunt-runner setup/);
  assert.throws(() => parseSetupArgs(['a.com', 'b', 'c']), /uso: duckhunt-runner setup/);
});

test('la carpeta de checkouts propuesta: la primera habitual que existe, o el home', () => {
  const home = os.homedir();
  assert.equal(defaultCodeDir((p) => p === path.join(home, 'code') || p === path.join(home, 'src')), path.join(home, 'code'));
  assert.equal(defaultCodeDir(() => false), home);
  assert.ok(fs.existsSync(defaultCodeDir()));
});

test('cuentas aws: una cuenta con un perfil se propone, con varios pregunta, la mapeada no y el perfil rechazado se dice', () => {
  const found = [
    { profile: 'prod', account: '111111111111', region: 'eu-west-1' },
    { profile: 'dev-ro', account: '222222222222', region: null },
    { profile: 'dev-admin', account: '222222222222', region: 'eu-west-1' },
    { profile: 'old', account: '333333333333', region: null },
    { profile: 'sso-x', account: null, region: null, error: 'sin sesión: `aws sso login --profile sso-x`' },
  ];
  const plan = planAwsAccounts(found, { '333333333333': { profile: 'old' } });
  assert.deepEqual(
    plan.fresh.map((c) => [c.account, c.profiles.map((p) => p.profile)]),
    [
      ['111111111111', ['prod']],
      ['222222222222', ['dev-ro', 'dev-admin']],
    ],
  );
  assert.deepEqual(plan.lines, [
    '  + 111111111111 ← perfil prod (eu-west-1)',
    '  ? 222222222222: perfiles dev-ro, dev-admin (eu-west-1)',
    '  = 333333333333 ya mapeada (perfil old)',
    '  ! perfil sso-x: sin sesión: `aws sso login --profile sso-x`',
  ]);
  assert.deepEqual(awsEntryOf(found[0]!), { profile: 'prod', region: 'eu-west-1' });
  assert.deepEqual(awsEntryOf(found[1]!), { profile: 'dev-ro' }, 'sin región, la entrada no la lleva');
});
