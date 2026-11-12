// el seam de drivers (t#440 P1) con un driver falso: el daemon solo habla con el cli por AgentDriver (anuncia lo que el
// driver dice, prepara, lanza y retira en ese orden, y una preparación rota cierra el segmento sin lanzar), y lo que
// el driver informa sale recortado y enmascarado por la plataforma, sea cual sea el driver. y el registro de drivers.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AgentDriver, HostFacts, PreparedSegment, SegmentIo, SegmentOutcome, SegmentSpec } from '../src/backends/agent-driver.js';
import { DriverRegistry } from '../src/backends/driver-registry.js';
import { parseClaim, type ClaimResponse } from '../src/claim.js';
import { loadConfig, type RunnerConfig } from '../src/config.js';
import { RunLease } from '../src/run-lease.js';
import { internals, legacyOf, type DaemonInternals } from './daemon-harness.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const HOST = 'agent-driver.test';
const RUN_ID = 701;
// más que el tope del result del status en el server (20k) y que el de la sesión (128).
const HUGE_CHARS = 30_000;
const RESULT_MAX_CHARS = 20_000;
const SESSION_MAX_CHARS = 128;
const SECRET = `${'gh'}p_${'a'.repeat(36)}`;
const FAKE_CAPABILITIES = ['events', 'prompt'];

class FakeDriver implements AgentDriver {
  readonly id = 'fake_agent';
  readonly command = 'fake-agent';
  version: string | null = '1.0.0';
  readonly calls: string[] = [];
  facts: HostFacts | null = null;

  constructor(private readonly broken = false) {}

  async detect(): Promise<void> {
    this.calls.push('detect');
  }

  start(): void {
    this.calls.push('start');
  }

  capabilities(facts: HostFacts): string[] {
    this.facts = facts;
    return FAKE_CAPABILITIES;
  }

  prepare(spec: SegmentSpec): PreparedSegment {
    this.calls.push(`prepare ${spec.claim.run.id} ${spec.platform.id}`);
    if (this.broken) throw new Error('no se pudo preparar el segmento');
    return { dispose: () => this.calls.push('dispose') };
  }

  async run(spec: SegmentSpec, _prepared: PreparedSegment, io: SegmentIo): Promise<SegmentOutcome> {
    this.calls.push('run');
    io.note('el agente falso trabaja');
    return {
      report: { status: 'done', result: `${SECRET} ${'x'.repeat(HUGE_CHARS)}`, toolCalls: 3, sessionId: 's'.repeat(HUGE_CHARS) },
      facts: { killedBy: null, exitCode: 0, isError: false, subtype: null },
      toolsByName: { Read: 3 },
      commands: () => {
        this.calls.push('commands');
        return null;
      },
    };
  }
}

const savedEnv = { ...process.env };
let root = '';
const statuses: Record<string, unknown>[] = [];
const events: { body?: string }[] = [];
const realFetch = globalThis.fetch;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-driver-'));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'a', refresh_token: 'r2', expires_in: 3600 });
    if (url.pathname.endsWith('/heartbeat')) return Response.json({ status: 'running', cancel: false });
    if (url.pathname.endsWith('/status')) statuses.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (url.pathname.endsWith('/events')) events.push(...((JSON.parse(String(init?.body)) as { events: { body?: string }[] }).events ?? []));
    return Response.json({ ok: true });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  Object.keys(process.env).forEach((k) => delete process.env[k]);
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

async function daemonWith(driver: FakeDriver, name: string): Promise<{ d: DaemonInternals & { capabilities(): string[]; announce(s: unknown): { claudeVersion: string | null } }; claim: ClaimResponse }> {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const config: RunnerConfig = { baseUrl: `https://${HOST}`, clientId: 'c1', refreshToken: 'r1', label: 'fa', repos: {}, aws: {}, defaults: {} };
  fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify(config), { mode: 0o600 });
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  const d = internals(loadConfig()!, { drivers: [driver] }) as DaemonInternals & { capabilities(): string[]; announce(s: unknown): { claudeVersion: string | null } };
  await d.reloadConfig();
  const raw = JSON.parse(fs.readFileSync(new URL('claim-kits/prompt-read-full.json', FIXTURES), 'utf8')) as Record<string, unknown>;
  const run = { ...(raw.run as Record<string, unknown>), id: RUN_ID, repo: null, branch: null, isolation: undefined, sessionId: null };
  return { d, claim: parseClaim({ ...raw, run } as unknown, { canBypass: true }) };
}

test('el daemon anuncia lo que dice su driver y lanza por la interfaz: preparar, lanzar, retirar; el informe sale recortado', async (t) => {
  t.mock.method(console, 'log', () => {});
  statuses.length = 0;
  events.length = 0;
  const driver = new FakeDriver();
  const { d, claim } = await daemonWith(driver, 'ok');
  assert.deepEqual(d.capabilities(), FAKE_CAPABILITIES);
  assert.equal(typeof driver.facts?.hasAws, 'boolean', 'le pasa lo que sabe de la máquina');
  assert.equal(d.announce(legacyOf(d)).claudeVersion, null, 'sin driver de claude, el cable no inventa su versión');
  await d.executeRun(legacyOf(d), claim, new RunLease(claim.run.id));
  assert.deepEqual(driver.calls, [`prepare ${RUN_ID} duckhunt`, 'run', 'dispose', 'commands']);
  const [status, ...more] = statuses;
  assert.equal(more.length, 0);
  assert.equal(status!.status, 'done');
  assert.equal((status!.result as string).length, RESULT_MAX_CHARS, 'el result, al tope del server');
  assert.equal((status!.result as string).includes(SECRET), false, 'y enmascarado');
  assert.equal((status!.sessionId as string).length, SESSION_MAX_CHARS);
  assert.ok(events.some((e) => e.body === 'el agente falso trabaja'), 'las notas del driver van al feed');
});

test('una preparación rota cierra el segmento como failed sin lanzar ni retirar nada', async (t) => {
  t.mock.method(console, 'log', () => {});
  statuses.length = 0;
  const driver = new FakeDriver(true);
  const { d, claim } = await daemonWith(driver, 'broken');
  await d.executeRun(legacyOf(d), claim, new RunLease(claim.run.id));
  assert.deepEqual(driver.calls, [`prepare ${RUN_ID} duckhunt`]);
  assert.deepEqual([statuses[0]?.status, statuses[0]?.error], ['failed', 'no se pudo preparar el segmento']);
});

test('registro de drivers: el primero es el principal, un backend sin driver lanza y no se repiten', () => {
  const a = new FakeDriver();
  const registry = new DriverRegistry([a]);
  assert.equal(registry.primary, a);
  assert.equal(registry.get('fake_agent'), a);
  assert.equal(registry.versionOf('fake_agent'), '1.0.0');
  assert.equal(registry.versionOf('claude_code'), null);
  assert.throws(() => registry.get('claude_code'), /no tiene driver para el backend claude_code/);
  assert.throws(() => new DriverRegistry([]), /al menos un driver/);
  assert.throws(() => new DriverRegistry([a, new FakeDriver()]), /repetido: fake_agent/);
});
