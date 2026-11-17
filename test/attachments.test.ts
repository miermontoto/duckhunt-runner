// adjuntos de una conversación en la máquina (t#680, src/attachments.ts): el bloque del claim re-validado, la bajada con
// su tamaño y su hash (y sin bajar lo que ya está), un fallo que no tumba el segmento, la ruta en el prompt en lugar del
// token, el deny de las carpetas ajenas y el barrido de las de conversaciones cerradas, con o sin worktree.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { attachmentFileName, attachmentFolders, syncAttachments, withAttachmentsDir, type AttachmentFetcher } from '../src/attachments.js';
import type { AgentDriver, HostFacts, PreparedSegment, SegmentOutcome, SegmentSpec } from '../src/backends/agent-driver.js';
import { parseClaim, type ClaimResponse } from '../src/claim.js';
import { loadConfig, runnerHome, type RunnerConfig } from '../src/config.js';
import { attachmentsPath, attachmentsRoot, LEGACY_PLATFORM_ID } from '../src/paths.js';
import { RunLease } from '../src/run-lease.js';
import { attachmentsDeny, secretPathsDeny } from '../src/secret-paths.js';
import { RUN_ATTACHMENT_MAX_BYTES, RUN_ATTACHMENTS_DIR_TOKEN, RUN_ATTACHMENTS_MAX, type LegacyClaimAttachment } from '../src/vendor/runner-protocol/index.js';
import { internals, legacyOf, runDenyOf, type DaemonInternals, type SupervisorInternals } from './daemon-harness.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const HOST = 'attachments.test';
const RUN_ID = 712;
const OTHER_RUN_ID = '713';
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const PHOTO = Buffer.from('png de mentira');
const NOTES = Buffer.from('# notas\n');
const entry = (id: number, name: string, bytes: Buffer): LegacyClaimAttachment => ({ id, name, size: bytes.length, sha256: sha256(bytes) });
const rule = (p: string, dir = true): string => `Read(/${p}${dir ? '/**' : ''})`;
const never = new AbortController().signal;

const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
let root = '';

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-attachments-')));
});

after(() => {
  globalThis.fetch = realFetch;
  Object.keys(process.env).forEach((k) => delete process.env[k]);
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

// un estado del daemon propio por prueba.
function freshHome(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const config: RunnerConfig = { baseUrl: `https://${HOST}`, clientId: 'c1', refreshToken: 'r1', label: 'fa', repos: {}, aws: {}, defaults: {} };
  fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify(config), { mode: 0o600 });
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  return dir;
}

const rawClaim = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const raw = JSON.parse(fs.readFileSync(new URL('claim-kits/prompt-read-full.json', FIXTURES), 'utf8')) as Record<string, unknown>;
  const run = { ...(raw.run as Record<string, unknown>), id: RUN_ID, repo: null, branch: null, isolation: undefined, sessionId: null };
  return { ...raw, run, ...over };
};
const parsed = (over: Record<string, unknown> = {}): ClaimResponse => parseClaim(rawClaim(over), { canBypass: true });

// una plataforma que sirve estos bytes por id (o un fallo para el resto) y apunta lo que le piden.
function serving(files: Record<number, Buffer>): { fetch: AttachmentFetcher; asked: number[] } {
  const asked: number[] = [];
  const fetch: AttachmentFetcher = async (id) => {
    asked.push(id);
    const bytes = files[id];
    return bytes ? { ok: true, body: Readable.from([bytes]) } : { ok: false, reason: 'el server respondió http 404' };
  };
  return { fetch, asked };
}

test('el bloque del claim se re-valida: lo que no tiene forma, pasa del tamaño o se repite se descarta con aviso', () => {
  const good = entry(1, 'foto.png', PHOTO);
  const claim = parsed({
    attachments: {
      files: [
        good,
        { ...entry(2, '../fuera', NOTES) },
        { ...entry(3, '.oculto', NOTES) },
        { ...entry(4, 'grande.bin', NOTES), size: RUN_ATTACHMENT_MAX_BYTES + 1 },
        { ...entry(5, 'sin-hash.txt', NOTES), sha256: 'abc' },
        { ...good, sha256: good.sha256.toUpperCase() },
        { ...entry(6, 'NOTAS.md', NOTES), sha256: sha256(NOTES).toUpperCase() },
      ],
    },
  });
  assert.deepEqual(claim.attachments?.files, [good, { ...entry(6, 'NOTAS.md', NOTES) }], 'el hash se normaliza a minúsculas');
  assert.equal(claim.warnings.length, 5);
  assert.ok(claim.warnings.some((w) => w.includes('adjunto 2: nombre "../fuera" no utilizable')));
  assert.ok(claim.warnings.some((w) => w.includes('adjunto 4 (grande.bin)') && w.includes('tope')));
  assert.ok(claim.warnings.some((w) => w.includes('adjunto 1 repetido')));
  assert.ok(claim.warnings.every((w) => !w.includes(root)), 'sin rutas de la máquina en los avisos que van al feed');
  // por encima del tope: solo los RUN_ATTACHMENTS_MAX primeros, el resto en un aviso.
  const many = Array.from({ length: RUN_ATTACHMENTS_MAX + 3 }, (_, i) => entry(i + 1, `f${i}.txt`, NOTES));
  const capped = parsed({ attachments: { files: many } });
  assert.equal(capped.attachments?.files.length, RUN_ATTACHMENTS_MAX);
  assert.deepEqual(capped.warnings, [`3 adjunto(s) por encima del tope de ${RUN_ATTACHMENTS_MAX}: se leen por mcp`]);
  // ilegible: cuenta como presente (su prompt ya nombra la carpeta), sin ficheros. ausente: sin bloque.
  const broken = parsed({ attachments: { files: 'x' } });
  assert.deepEqual(broken.attachments, { files: [] });
  assert.ok(broken.warnings.includes('bloque attachments ilegible: los adjuntos se leen por mcp'));
  assert.equal('attachments' in parsed(), false);
});

test('bajada: tamaño y sha256 verificados, lo que ya está con ese hash no se vuelve a pedir y lo que sobra se borra', async () => {
  freshHome('sync');
  const dir = attachmentsPath(LEGACY_PLATFORM_ID, String(RUN_ID));
  const files = [entry(1, 'foto.png', PHOTO), entry(2, 'notas.md', NOTES)];
  const first = serving({ 1: PHOTO, 2: NOTES });
  const notes: string[] = [];
  assert.deepEqual(await syncAttachments(files, dir, first.fetch, (n) => notes.push(n), never), { ready: 2, failed: 0 });
  assert.deepEqual(first.asked, [1, 2]);
  assert.equal(notes.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(dir, attachmentFileName(files[0]!))), PHOTO);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'carpeta privada');
  // el agente dejó un fichero suyo; el siguiente claim ya no cita las notas y la foto sigue igual.
  fs.writeFileSync(path.join(dir, 'resumen.txt'), 'del agente');
  const second = serving({ 1: PHOTO });
  assert.deepEqual(await syncAttachments([files[0]!], dir, second.fetch, (n) => notes.push(n), never), { ready: 1, failed: 0 });
  assert.deepEqual(second.asked, [], 'ya estaba con ese hash');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['1-foto.png', 'resumen.txt'], 'las notas ya no son de la conversación');
  // el fichero cambió en disco (otro hash): se vuelve a bajar.
  fs.writeFileSync(path.join(dir, '1-foto.png'), Buffer.alloc(PHOTO.length));
  const third = serving({ 1: PHOTO });
  await syncAttachments([files[0]!], dir, third.fetch, () => {}, never);
  assert.deepEqual(third.asked, [1]);
  assert.deepEqual(fs.readFileSync(path.join(dir, '1-foto.png')), PHOTO);
});

test('bajada fallida: un hash que no casa, más bytes de los anunciados o un http de error dejan nota y nada a medias', async () => {
  freshHome('sync-fail');
  const dir = attachmentsPath(LEGACY_PLATFORM_ID, String(RUN_ID));
  const lying = { ...entry(1, 'foto.png', PHOTO), sha256: sha256(NOTES) };
  const short = { ...entry(2, 'corto.txt', NOTES), size: NOTES.length - 2 };
  const missing = entry(3, 'perdido.txt', NOTES);
  // un symlink plantado donde iría la bajada a medias: se borra, no se sigue.
  const victim = path.join(root, 'sync-fail', 'victima.txt');
  fs.writeFileSync(victim, 'intacto');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(victim, path.join(dir, '.3-perdido.txt.part'));
  const notes: string[] = [];
  const out = await syncAttachments([lying, short, missing], dir, serving({ 1: PHOTO, 2: NOTES }).fetch, (n) => notes.push(n), never);
  assert.deepEqual(out, { ready: 0, failed: 3 });
  assert.deepEqual(notes, [
    'adjunto 1 (foto.png) sin bajar: el sha256 no casa; el agente lo lee por mcp',
    `adjunto 2 (corto.txt) sin bajar: más de los ${NOTES.length - 2} bytes anunciados; el agente lo lee por mcp`,
    'adjunto 3 (perdido.txt) sin bajar: el server respondió http 404; el agente lo lee por mcp',
  ]);
  assert.deepEqual(fs.readdirSync(dir), [], 'ni el fichero ni su .part');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'intacto');
  // una plataforma que no sirve adjuntos: lo mismo, con su motivo.
  const none: string[] = [];
  await syncAttachments([missing], dir, null, (n) => none.push(n), never);
  assert.deepEqual(none, ['adjunto 3 (perdido.txt) sin bajar: la plataforma no sirve adjuntos; el agente lo lee por mcp']);
});

test('el token del prompt y del de respaldo pasa a la ruta, sin patrones de reemplazo; sin token, byte a byte igual', () => {
  const claim = parsed({ prompt: `mira ${RUN_ATTACHMENTS_DIR_TOKEN}/1-foto.png y ${RUN_ATTACHMENTS_DIR_TOKEN}`, fallbackPrompt: `desde cero: ${RUN_ATTACHMENTS_DIR_TOKEN}` });
  const dir = '/home/u/$&/attachments/712';
  const out = withAttachmentsDir(claim, dir);
  assert.equal(out.prompt, `mira ${dir}/1-foto.png y ${dir}`);
  assert.equal(out.fallbackPrompt, `desde cero: ${dir}`);
  const plain = parsed();
  assert.equal(withAttachmentsDir(plain, dir).prompt, plain.prompt);
  assert.equal(withAttachmentsDir(plain, dir).fallbackPrompt, null);
});

// un driver que solo apunta con qué claim lo lanzan.
class RecordingDriver implements AgentDriver {
  readonly id = 'fake_agent';
  readonly command = 'fake-agent';
  readonly version = '1.0.0';
  prompts: string[] = [];
  async detect(): Promise<void> {}
  start(): void {}
  capabilities(_facts: HostFacts): string[] {
    return ['prompt', 'attachments'];
  }
  prepare(spec: SegmentSpec): PreparedSegment {
    this.prompts.push(spec.claim.prompt);
    return { dispose: () => {} };
  }
  async run(): Promise<SegmentOutcome> {
    return { report: { status: 'done', result: 'ok' }, facts: { killedBy: null, exitCode: 0, isError: false, subtype: null }, toolsByName: {}, commands: () => null };
  }
}

test('segmento: baja con la credencial del daemon, un fallo no lo tumba y el driver recibe el prompt con la ruta', async (t) => {
  t.mock.method(console, 'log', () => {});
  freshHome('segment');
  const statuses: Record<string, unknown>[] = [];
  const events: { body?: string }[] = [];
  const gets: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'a', refresh_token: 'r2', expires_in: 3600 });
    if (url.pathname.includes('/attachments/')) {
      gets.push(`${init?.method} ${url.pathname} ${(init?.headers as Record<string, string>).Authorization}`);
      return url.pathname.endsWith('/1') ? new Response(PHOTO) : Response.json({ error: 'no existe' }, { status: 404 });
    }
    if (url.pathname.endsWith('/heartbeat')) return Response.json({ status: 'running', cancel: false });
    if (url.pathname.endsWith('/status')) statuses.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (url.pathname.endsWith('/events')) events.push(...((JSON.parse(String(init?.body)) as { events: { body?: string }[] }).events ?? []));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const driver = new RecordingDriver();
  const d = internals(loadConfig()!, { drivers: [driver] });
  await d.reloadConfig();
  const claim = parsed({
    prompt: `adjuntos en ${RUN_ATTACHMENTS_DIR_TOKEN}`,
    attachments: { files: [entry(1, 'foto.png', PHOTO), entry(2, 'perdido.txt', NOTES)] },
  });
  await d.executeRun(legacyOf(d), claim, new RunLease(claim.run.id));
  const dir = attachmentsPath(LEGACY_PLATFORM_ID, String(RUN_ID));
  assert.deepEqual(gets, [`GET /api/runner/runs/${RUN_ID}/attachments/1 Bearer a`, `GET /api/runner/runs/${RUN_ID}/attachments/2 Bearer a`]);
  assert.deepEqual(driver.prompts, [`adjuntos en ${dir}`]);
  assert.deepEqual(fs.readdirSync(dir), ['1-foto.png']);
  assert.equal(statuses[0]?.status, 'done', 'el adjunto que no bajó no tumba el segmento');
  const bodies = events.map((e) => e.body ?? '');
  assert.ok(bodies.some((b) => b.startsWith('adjunto 2 (perdido.txt) sin bajar: el server respondió http 404')), bodies.join(' | '));
  assert.ok(bodies.includes('adjuntos: 1 de 2 en la carpeta del run'));
  // sin el bloque, ni carpeta ni cambio en el prompt.
  driver.prompts = [];
  const plain = parsed({ run: { ...(rawClaim().run as object), id: RUN_ID + 1 } });
  await d.executeRun(legacyOf(d), plain, new RunLease(plain.run.id));
  assert.deepEqual(driver.prompts, [plain.prompt]);
  assert.equal(fs.existsSync(attachmentsPath(LEGACY_PLATFORM_ID, String(RUN_ID + 1))), false);
});

test('deny: las carpetas de las otras conversaciones y la raíz de las otras plataformas; la propia, no', async () => {
  freshHome('deny');
  const own = attachmentsPath(LEGACY_PLATFORM_ID, String(RUN_ID));
  const sibling = attachmentsPath(LEGACY_PLATFORM_ID, OTHER_RUN_ID);
  [own, sibling].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  const rules = attachmentsDeny(LEGACY_PLATFORM_ID, String(RUN_ID), ['beta']);
  assert.deepEqual(rules, [rule(sibling), rule(attachmentsRoot('beta'))]);
  assert.deepEqual(attachmentsDeny(LEGACY_PLATFORM_ID, null, []).sort(), [rule(own), rule(sibling)].sort(), 'sin conversación, todas');
  assert.deepEqual(attachmentsDeny('beta', '9', [LEGACY_PLATFORM_ID]), [rule(attachmentsRoot(LEGACY_PLATFORM_ID))], 'la legacy, entera');
  // los kits de lectura ya no niegan la raíz entera (ganaría a la carpeta propia): va por segmento.
  fs.mkdirSync(path.join(runnerHome(), 'platforms', 'beta', 'attachments'), { recursive: true });
  const secrets = secretPathsDeny({}, path.join(root, 'deny')).rules;
  assert.ok(!secrets.some((r) => r.includes('/attachments')), secrets.join('\n'));
  // y el driver de claude lo añade al deny de todo kit, detrás de lo de siempre.
  const d = internals(loadConfig()!);
  await d.reloadConfig();
  const deny = runDenyOf(d, legacyOf(d), String(RUN_ID));
  assert.deepEqual(deny.slice(-2), [rule(sibling), rule(attachmentsRoot('beta'))]);
  assert.ok(!deny.includes(rule(own)));
});

test('barrido: la carpeta de una conversación cerrada cae aunque no tenga worktree; la abierta y la que corre, no', async (t) => {
  t.mock.method(console, 'log', () => {});
  freshHome('sweep');
  const asked: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'a', refresh_token: 'r2', expires_in: 3600 });
    if (url.pathname.endsWith('/conversations')) {
      asked.push(JSON.parse(String(init?.body)));
      return Response.json({ open: [20] });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  const d = internals(loadConfig()!) as DaemonInternals & { collectWorktrees(sup: SupervisorInternals): Promise<void> };
  await d.reloadConfig();
  const sup = legacyOf(d);
  ['10', '20', '30', 'no-es-un-run.x'].forEach((id) => fs.mkdirSync(path.join(attachmentsRoot(LEGACY_PLATFORM_ID), id), { recursive: true }));
  sup.leases.add(new RunLease('30'));
  await d.collectWorktrees(sup);
  assert.deepEqual(asked, [{ runIds: [10, 20, 30] }], 'una consulta, con las carpetas sin worktree');
  assert.deepEqual(attachmentFolders(LEGACY_PLATFORM_ID).map((f) => f.runId).sort(), ['20', '30'], 'cae la cerrada; la abierta y la que corre se quedan');
  assert.ok(fs.existsSync(path.join(attachmentsRoot(LEGACY_PLATFORM_ID), 'no-es-un-run.x')), 'lo que no es de un run no se toca');
});
