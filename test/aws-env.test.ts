// aws_strict (0.11.0, t#465 P12): la cuenta del claim con su perfil mapeado; una cuenta que esta máquina no
// mapea, sin credenciales de ningún tipo (ficheros vacíos del run, sin perfil, sin claves ni metadata); y
// sin cuenta, el env del usuario tal cual.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { clearRunAwsConfigs, runAwsEnv, writeEmptyAwsConfig } from '../src/aws-env.js';

const ACCOUNT = '123456789012';
const OTHER = '999999999999';
const MAP = { [ACCOUNT]: { profile: 'prod', region: 'eu-west-1' } };
const USER_ENV = {
  PATH: '/usr/bin',
  AWS_PROFILE: 'default-de-otra-cuenta',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secreto',
  AWS_SESSION_TOKEN: 'sesion',
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials',
};
let home = '';
let prevHome: string | undefined;

before(() => {
  prevHome = process.env.DUCKHUNT_RUNNER_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-aws-')));
  process.env.DUCKHUNT_RUNNER_HOME = home;
});

after(() => {
  if (prevHome === undefined) delete process.env.DUCKHUNT_RUNNER_HOME;
  else process.env.DUCKHUNT_RUNNER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const noDir = (): string => assert.fail('sin cuenta sin mapear no hace falta la aws vacía');

test('cuenta mapeada: su perfil y su región; nada se crea', () => {
  const { env, unmapped } = runAwsEnv(USER_ENV, { accountId: ACCOUNT, region: 'us-east-1' }, MAP, noDir);
  assert.equal(unmapped, null);
  assert.equal(env.AWS_PROFILE, 'prod');
  assert.equal(env.AWS_DEFAULT_REGION, 'eu-west-1', 'la región del mapa manda');
  assert.equal(env.AWS_CONFIG_FILE, undefined);
});

test('cuenta sin mapear: falla cerrado, sin perfil, claves, contenedor ni metadata, con ficheros vacíos', () => {
  const dir = writeEmptyAwsConfig('42');
  const { env, unmapped } = runAwsEnv(USER_ENV, { accountId: OTHER, region: 'eu-west-1' }, MAP, () => dir);
  assert.equal(unmapped, OTHER);
  ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'].forEach((k) =>
    assert.equal(env[k], undefined, k),
  );
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(env.AWS_DEFAULT_REGION, 'eu-west-1');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(fs.readFileSync(env.AWS_CONFIG_FILE!, 'utf8'), '');
  assert.equal(fs.readFileSync(env.AWS_SHARED_CREDENTIALS_FILE!, 'utf8'), '');
  assert.equal(path.dirname(env.AWS_CONFIG_FILE!), dir);
  assert.ok(dir.startsWith(path.join(home, 'run-config')), 'bajo el directorio 0700 de configs de run, negado a Read');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(USER_ENV.AWS_PROFILE, 'default-de-otra-cuenta', 'no muta el env de origen');
});

test('sin cuenta (o sin aws): el env del usuario tal cual, con la región si viene', () => {
  assert.deepEqual(runAwsEnv(USER_ENV, null, MAP, noDir), { env: USER_ENV, unmapped: null });
  const { env } = runAwsEnv(USER_ENV, { accountId: null, region: 'eu-south-2' }, MAP, noDir);
  assert.equal(env.AWS_PROFILE, 'default-de-otra-cuenta');
  assert.equal(env.AWS_DEFAULT_REGION, 'eu-south-2');
});

test('al arrancar se borran los directorios de aws vacía que dejó un daemon muerto', () => {
  writeEmptyAwsConfig('7');
  assert.ok(clearRunAwsConfigs() >= 1);
  assert.equal(fs.readdirSync(path.join(home, 'run-config')).filter((n) => n.startsWith('aws-')).length, 0);
});
