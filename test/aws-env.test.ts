// aws_strict (0.11.0, t#465 P12): la cuenta del claim con su perfil mapeado; una cuenta que esta máquina no
// mapea, sin credenciales de ningún tipo (ficheros vacíos del run, sin perfil, sin claves ni metadata); y
// sin cuenta, el env del usuario tal cual. y el recurso aws (t#495, M2): lo mismo como diff, `default` solo
// si el usuario la mapea, y aislar (la aws vacía de un claim toolset_v1 que no pide aws).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AWS_DEFAULT_KEY, AWS_PARAM, AWS_TYPE, awsProvider, clearRunAwsConfigs, isAwsKey, runAwsEnv, unmappedAwsWarning, writeEmptyAwsConfig } from '../src/resources/aws.js';
import { ACCESS, RELEASE, type ResourceRequest, type RunContext } from '../src/resources/types.js';
import { KeyedMutex } from '../src/keyed-mutex.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';

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
  const dir = writeEmptyAwsConfig('42', LEGACY_PLATFORM_ID);
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
  writeEmptyAwsConfig('7', LEGACY_PLATFORM_ID);
  assert.ok(clearRunAwsConfigs(LEGACY_PLATFORM_ID) >= 1);
  assert.equal(fs.readdirSync(path.join(home, 'run-config')).filter((n) => n.startsWith('aws-')).length, 0);
});

// --- el recurso aws (t#495, M2): lo mismo como diff sobre el env de partida, `default` y aislar ---

const ctx = (runId: string): RunContext => ({ platform: LEGACY_PLATFORM_ID, runId, env: USER_ENV, gitLocks: new KeyedMutex() });
const req = (key: string | null, region: string | null = null): ResourceRequest => ({ type: AWS_TYPE, key, access: ACCESS.read, params: { [AWS_PARAM.region]: region } });
const awsDirs = (): string[] => fs.readdirSync(path.join(home, 'run-config')).filter((n) => n.startsWith('aws-'));

test('recurso aws: cuenta mapeada = perfil y región como diff, sin aviso ni ficheros', async () => {
  const m = await awsProvider.materialize(req(ACCOUNT, 'us-east-1'), MAP[ACCOUNT]!, ctx('50'));
  assert.deepEqual(m.env, { AWS_PROFILE: 'prod', AWS_DEFAULT_REGION: 'eu-west-1' });
  assert.deepEqual(m.warnings, []);
  await m.release(RELEASE.done);
});

test('recurso aws: cuenta sin mapear = la aws vacía con aviso; al soltar se borra su directorio', async () => {
  const before = awsDirs().length;
  const m = await awsProvider.materialize(req(OTHER, 'eu-west-1'), null, ctx('51'));
  ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'].forEach((k) => assert.equal(m.env?.[k], null, k));
  assert.equal(m.env?.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(m.env?.AWS_DEFAULT_REGION, 'eu-west-1');
  assert.equal(fs.readFileSync(m.env!.AWS_CONFIG_FILE!, 'utf8'), '');
  assert.deepEqual(m.warnings, [unmappedAwsWarning(OTHER)]);
  assert.equal(awsDirs().length, before + 1);
  await m.release(RELEASE.aborted);
  assert.equal(awsDirs().length, before);
});

test('recurso aws: sin cuenta solo la región; `default` es una clave más, solo si el usuario la mapea', async () => {
  assert.deepEqual((await awsProvider.materialize(req(null, 'eu-south-2'), null, ctx('52'))).env, { AWS_DEFAULT_REGION: 'eu-south-2' });
  assert.deepEqual((await awsProvider.materialize(req(null), null, ctx('53'))).env, {}, 'sin cuenta ni región: el env del usuario tal cual');
  const exposed = await awsProvider.materialize(req(AWS_DEFAULT_KEY), { profile: 'personal' }, ctx('54'));
  assert.deepEqual(exposed.env, { AWS_PROFILE: 'personal' });
  const unexposed = await awsProvider.materialize(req(AWS_DEFAULT_KEY), null, ctx('55'));
  assert.equal(unexposed.env?.AWS_PROFILE, null, 'sin mapear, `default` tampoco cae en el perfil por defecto del usuario');
  await unexposed.release(RELEASE.done);
  assert.equal(isAwsKey(AWS_DEFAULT_KEY) && isAwsKey(ACCOUNT) && !isAwsKey('12345'), true);
});

test('recurso aws: aislar = la aws vacía sin región ni aviso, y se borra al soltar', async () => {
  const before = awsDirs().length;
  const m = await awsProvider.isolate!(ctx('56'));
  assert.equal(m.env?.AWS_PROFILE, null);
  assert.equal(m.env?.AWS_DEFAULT_REGION, undefined);
  assert.equal(m.env?.AWS_EC2_METADATA_DISABLED, 'true');
  assert.deepEqual(m.warnings, []);
  await m.release(RELEASE.canceled);
  assert.equal(awsDirs().length, before);
  writeEmptyAwsConfig('57', LEGACY_PLATFORM_ID);
  assert.equal(awsProvider.sweep!(LEGACY_PLATFORM_ID), 1, 'el barrido al arrancar es el de siempre');
});
