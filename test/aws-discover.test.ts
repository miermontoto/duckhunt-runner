// `aws discover` contra una aws cli falsa en el PATH: mapea las cuentas de los perfiles guardados sin escribir ids,
// deja sin mapear una cuenta con varios perfiles hasta que se nombra uno, no toca lo ya mapeado, `--dry-run` no
// escribe y un perfil que sts rechaza se lista sin bloquear.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { awsCommand } from '../src/aws.js';
import { loadStoredConfig } from '../src/config.js';

const PROD = '111111111111';
const SHARED = '222222222222';
const MAPPED = '333333333333';
// perfil → cuenta que devuelve sts (vacía = rechazo); región de los que la tienen.
const FAKE_AWS = `#!/bin/sh
profile=""
prev=""
for a in "$@"; do [ "$prev" = "--profile" ] && profile="$a"; prev="$a"; done
case "$1 $2" in
  "configure list-profiles") printf 'prod\\nread\\nadmin\\nold\\nexpired\\n' ;;
  "configure get") [ "$profile" = "prod" ] && echo eu-west-1 || exit 1 ;;
  "sts get-caller-identity")
    case "$profile" in
      prod) echo ${PROD} ;;
      read|admin) echo ${SHARED} ;;
      old) echo ${MAPPED} ;;
      *) echo "Error when retrieving token from sso: Token has expired" >&2; exit 255 ;;
    esac ;;
  *) exit 2 ;;
esac
`;

let root = '';
const realPath = process.env.PATH;
const configFile = (): string => process.env.DUCKHUNT_RUNNER_CONFIG!;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-aws-discover-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'aws'), FAKE_AWS, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${realPath}`;
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(root, 'runner.json');
});

beforeEach(() => {
  process.exitCode = 0;
  fs.writeFileSync(configFile(), JSON.stringify({ baseUrl: 'https://duckhunt.test', repos: {}, aws: { [MAPPED]: { profile: 'old' } } }));
});

after(() => {
  process.env.PATH = realPath;
  delete process.env.DUCKHUNT_RUNNER_CONFIG;
  fs.rmSync(root, { recursive: true, force: true });
});

const output = (calls: readonly { arguments: unknown[] }[]): string => calls.map((c) => String(c.arguments[0])).join('\n');

test('aws discover: mapea las cuentas de un solo perfil con su región y deja las ambiguas y las rechazadas', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  await awsCommand(['discover']);
  assert.deepEqual(loadStoredConfig()!.aws, { [MAPPED]: { profile: 'old' }, [PROD]: { profile: 'prod', region: 'eu-west-1' } });
  const text = output(log.mock.calls);
  assert.match(text, new RegExp(`= ${MAPPED} ya mapeada`));
  assert.match(text, new RegExp(`\\? ${SHARED}: perfiles read, admin`));
  assert.match(text, new RegExp(`sin mapear ${SHARED}: elige su perfil`));
  assert.match(text, /! perfil expired: sin sesión: `aws sso login --profile expired`/);
  assert.equal(process.exitCode, 0);
});

test('aws discover <perfil>: nombrar un perfil resuelve la cuenta ambigua', async (t) => {
  t.mock.method(console, 'log', () => {});
  await awsCommand(['discover', 'admin']);
  assert.deepEqual(loadStoredConfig()!.aws[SHARED], { profile: 'admin' });
});

test('aws discover --dry-run no escribe; un perfil desconocido o un flag ajeno fallan', async (t) => {
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const before = fs.readFileSync(configFile(), 'utf8');
  await awsCommand(['discover', '--dry-run']);
  assert.equal(fs.readFileSync(configFile(), 'utf8'), before);
  await awsCommand(['discover', 'nope']);
  assert.equal(process.exitCode, 1);
  assert.match(output(error.mock.calls), /perfil\(es\) que la aws cli no tiene: nope/);
  process.exitCode = 0;
  await awsCommand(['discover', '--s3-read']);
  assert.equal(process.exitCode, 1);
  assert.equal(fs.readFileSync(configFile(), 'utf8'), before);
  process.exitCode = 0;
});
