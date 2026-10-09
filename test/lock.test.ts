// un solo daemon por directorio de estado (daemon-lock.ts): un segundo `start` se niega mientras el
// dueño vive (entre procesos de verdad), un lock huérfano (pid muerto, el propio, ilegible, de otro
// arranque del sistema) se reemplaza y soltarlo solo quita el lock propio.

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { acquireDaemonLock, daemonLockHolder, daemonLockPath } from '../src/daemon-lock.js';

const LOCK_MODULE = new URL('../src/daemon-lock.js', import.meta.url).href;
const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';
const CLI = new URL('../src/index.js', import.meta.url);
// proceso que toma el lock como `start` (lo suelta al salir; SIGTERM sale como los handlers del
// daemon) y se queda vivo hasta que lo matan.
const HOLDER_SCRIPT = `const { acquireDaemonLock } = await import(process.argv[1]); process.once('exit', acquireDaemonLock()); process.on('SIGTERM', () => process.exit(143)); console.log('ok'); setInterval(() => {}, 60000);`;

let root = '';
const children: ChildProcess[] = [];

async function holder(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER_SCRIPT, LOCK_MODULE], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  const [line] = (await once(child.stdout!, 'data')) as [Buffer];
  assert.equal(line.toString().trim(), 'ok');
  return child;
}

async function kill9(child: ChildProcess): Promise<void> {
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

// pid de un proceso que ya terminó.
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid!;
}

const writeLock = (content: string): void => {
  fs.mkdirSync(path.dirname(daemonLockPath()), { recursive: true });
  fs.writeFileSync(daemonLockPath(), content);
};
const lockPid = (): number => (JSON.parse(fs.readFileSync(daemonLockPath(), 'utf-8')) as { pid: number }).pid;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-lock-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
});

afterEach(() => {
  children.splice(0).forEach((c) => c.kill('SIGKILL'));
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('libre: se toma con el pid y la config, y se suelta', () => {
  const release = acquireDaemonLock();
  const content = JSON.parse(fs.readFileSync(daemonLockPath(), 'utf-8')) as { pid: number; config: string };
  assert.equal(content.pid, process.pid);
  assert.equal(content.config, path.resolve(process.env.DUCKHUNT_RUNNER_CONFIG!));
  assert.equal(fs.statSync(daemonLockPath()).mode & 0o777, 0o600);
  release();
  assert.equal(fs.existsSync(daemonLockPath()), false);
});

test('un segundo daemon se niega mientras el primero vive, y lo reemplaza cuando muere sin soltarlo', async () => {
  const first = await holder();
  assert.throws(() => acquireDaemonLock(), new RegExp(`ya hay un daemon en marcha \\(pid ${first.pid}`));
  assert.equal(daemonLockHolder()?.pid, first.pid);
  assert.equal(daemonLockHolder()?.config, path.resolve(process.env.DUCKHUNT_RUNNER_CONFIG!));
  // kill -9: el lock queda en disco con un pid muerto.
  await kill9(first);
  assert.equal(lockPid(), first.pid);
  assert.equal(daemonLockHolder(), null);
  const release = acquireDaemonLock();
  assert.equal(lockPid(), process.pid);
  release();
});

test('el dueño suelta el lock al salir', async () => {
  const first = await holder();
  const exited = once(first, 'exit');
  first.kill('SIGTERM');
  await exited;
  assert.equal(fs.existsSync(daemonLockPath()), false);
});

test('lock huérfano: pid muerto, el propio o ilegible se reemplazan', async () => {
  const dead = await deadPid();
  [JSON.stringify({ pid: dead, config: '/x', startedAt: 'ayer' }), JSON.stringify({ pid: process.pid, config: '/x' }), '{ a medias'].forEach((content) => {
    writeLock(content);
    const release = acquireDaemonLock();
    assert.equal(lockPid(), process.pid);
    release();
  });
});

test('un lock de otro arranque del sistema es huérfano aunque su pid viva (pids reutilizados)', { skip: !fs.existsSync(BOOT_ID_FILE) }, async () => {
  const live = await holder();
  writeLock(JSON.stringify({ pid: live.pid, config: '/x', startedAt: 'antes del reinicio', bootId: 'otro-arranque' }));
  assert.equal(daemonLockHolder(), null);
  const release = acquireDaemonLock();
  const content = JSON.parse(fs.readFileSync(daemonLockPath(), 'utf-8')) as { pid: number; bootId?: string };
  assert.equal(content.pid, process.pid);
  assert.equal(content.bootId, fs.readFileSync(BOOT_ID_FILE, 'utf-8').trim());
  release();
});

test('soltar no quita un lock que ya es de otro', () => {
  const release = acquireDaemonLock();
  writeLock(JSON.stringify({ pid: process.ppid, config: '/otro', startedAt: 'ahora' }));
  release();
  assert.equal(lockPid(), process.ppid);
});

test('`start` con otro daemon en marcha sale con error sin arrancar', async () => {
  fs.writeFileSync(process.env.DUCKHUNT_RUNNER_CONFIG!, JSON.stringify({ baseUrl: 'https://duckhunt.test', clientId: 'c1', refreshToken: 'r1' }));
  const first = await holder();
  const res = spawnSync(process.execPath, [CLI.pathname, 'start'], { env: process.env, encoding: 'utf-8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`ya hay un daemon en marcha \\(pid ${first.pid}`));
  assert.equal(lockPid(), first.pid);
});
