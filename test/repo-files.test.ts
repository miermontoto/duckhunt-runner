// índice de ficheros de los repos (t#678, repo-files.ts) sobre repos git reales en un tmpdir: qué lista y en qué orden,
// los topes, la subida con su huella, lo que hace con cada respuesta del server (la plataforma duckhunt-42) y cuándo la
// lanza el daemon.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { configPath, loadConfig, type RunnerConfig } from '../src/config.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import { Duckhunt42Platform } from '../src/platforms/duckhunt42.js';
import type { HttpTransport } from '../src/platforms/http-transport.js';
import {
  buildRepoFiles,
  listRepoFiles,
  REPO_FILES_LIMITS,
  REPO_FILES_RETRY_MS,
  REPO_FILES_UPLOAD,
  RepoFilesSync,
  type RepoFilesOutcome,
} from '../src/repo-files.js';
import { scrubEnv } from '../src/scrub-env.js';
import {
  REPO_FILES_BODY_MAX_BYTES,
  REPO_FILES_MAX,
  REPO_FILES_REFRESH_MS,
  RUNNER_REPO_FILES_PATH,
  type RunnerRepoFiles,
} from '../src/vendor/runner-protocol/index.js';
import { internals, legacyOf } from './daemon-harness.js';
import { fakeFactories, UNAVAILABLE } from './fake-platform.js';

// git sin la config de la máquina (ni su excludesFile ni su firma) y con identidad.
const env: NodeJS.ProcessEnv = {
  ...scrubEnv(process.env),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf-8' }).trim();
const REPO = 'acme/api';
const LONG_PATH = `${'a'.repeat(200)}/${'b'.repeat(200)}/c.txt`;
// lo que debe salir del repo de prueba: lo menos profundo primero, luego por orden alfabético.
const EXPECTED = ['.gitignore', 'README.md', 'new.ts', 'z.txt', 'src/a.ts', 'src/c.ts', 'src/deep/b.ts'];
let root = '';
let repo = '';

const write = (dir: string, file: string, body = 'x\n'): void => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
};

// versionados, nuevos sin ignorar, ignorados, rutas que no caben (comillas, barra invertida, tab, demasiado larga) y un
// repo anidado sin versionar (git lo lista como `vendor/lib/`).
function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(root, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, '.gitignore', '*.log\nbuild/\n');
  ['README.md', 'src/a.ts', 'src/deep/b.ts', 'z.txt'].forEach((f) => write(dir, f));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  ['new.ts', 'src/c.ts', 'debug.log', 'build/out.js', 'quo"te.txt', 'back\\slash.txt', 'tab\tname.txt', LONG_PATH].forEach((f) => write(dir, f));
  const nested = path.join(dir, 'vendor', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q');
  write(nested, 'index.js');
  return dir;
}

const bodyBytes = (files: string[]): number => Buffer.byteLength(JSON.stringify({ repo: REPO, files, truncated: false }));

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-repo-files-'));
  repo = fixtureRepo();
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

// --- el índice de un repo ---

test('lista lo versionado y lo nuevo sin ignorar, sin las rutas que no caben ni directorios, y en su orden', async () => {
  const listed = await listRepoFiles(repo, env);
  assert.ok(listed.includes(LONG_PATH) && listed.includes('vendor/lib/'), 'git sí las lista: las quita el builder');
  assert.deepEqual(buildRepoFiles(REPO, listed), { repo: REPO, files: EXPECTED, truncated: false });
});

test('recorta a las rutas del tope, lo menos profundo primero, y lo dice', async () => {
  const listed = await listRepoFiles(repo, env);
  assert.deepEqual(buildRepoFiles(REPO, listed, { ...REPO_FILES_LIMITS, files: 3 }), { repo: REPO, files: EXPECTED.slice(0, 3), truncated: true });
});

test('recorta hasta que el cuerpo json cabe en los bytes del tope', async () => {
  const listed = await listRepoFiles(repo, env);
  const exact = bodyBytes(EXPECTED.slice(0, 4));
  const fits = buildRepoFiles(REPO, listed, { ...REPO_FILES_LIMITS, bodyBytes: exact });
  assert.deepEqual([fits.files, fits.truncated], [EXPECTED.slice(0, 4), true]);
  assert.ok(Buffer.byteLength(JSON.stringify(fits)) <= exact);
  assert.deepEqual(buildRepoFiles(REPO, listed, { ...REPO_FILES_LIMITS, bodyBytes: exact - 1 }).files, EXPECTED.slice(0, 3), 'un byte menos: una ruta menos');
});

test('con los topes del protocolo: sin repetidas, como mucho REPO_FILES_MAX rutas y nunca más bytes de los que acepta el server', () => {
  assert.deepEqual(buildRepoFiles(REPO, ['b', 'a', 'b', '']), { repo: REPO, files: ['a', 'b'], truncated: false });
  const many = Array.from({ length: REPO_FILES_MAX + 5 }, (_, i) => `f${String(i).padStart(6, '0')}`);
  const capped = buildRepoFiles(REPO, many);
  assert.deepEqual([capped.files.length, capped.files[0], capped.truncated], [REPO_FILES_MAX, 'f000000', true]);
  const heavy = Array.from({ length: REPO_FILES_MAX }, (_, i) => `src/${String(i).padStart(6, '0')}-${'x'.repeat(140)}.ts`);
  const trimmed = buildRepoFiles(REPO, heavy);
  const bytes = Buffer.byteLength(JSON.stringify(trimmed));
  assert.ok(trimmed.truncated && trimmed.files.length < REPO_FILES_MAX);
  assert.ok(bytes <= REPO_FILES_BODY_MAX_BYTES && bytes > REPO_FILES_BODY_MAX_BYTES - 160, `${bytes} bytes: lleno hasta la última ruta que cabe`);
});

test('un directorio que no es un checkout no se lista', async () => {
  await assert.rejects(listRepoFiles(fs.mkdtempSync(path.join(root, 'plain-')), env));
});

// --- la subida de duckhunt-42 ---

// la plataforma sobre un transporte que contesta `answer` y apunta lo que se le manda.
function platformAnswering(answer: number | Error): { platform: Duckhunt42Platform; posted: [string, unknown][] } {
  const posted: [string, unknown][] = [];
  const transport = {
    post: async (pathname: string, body: unknown): Promise<Response> => {
      posted.push([pathname, body]);
      if (answer instanceof Error) throw answer;
      return Response.json({ changed: true, files: 1, truncated: false }, { status: answer });
    },
  };
  return { platform: new Duckhunt42Platform(LEGACY_PLATFORM_ID, transport as unknown as HttpTransport), posted };
}

test('duckhunt-42: 200 guardado, 404 sin la ruta, 400/413 índice rechazado, 409/5xx/red se reintentan', async (t) => {
  t.mock.method(console, 'error', () => {});
  const body: RunnerRepoFiles = { repo: REPO, files: ['README.md'], truncated: false };
  const cases: [number | Error, RepoFilesOutcome][] = [
    [200, REPO_FILES_UPLOAD.ok],
    [404, REPO_FILES_UPLOAD.unsupported],
    [400, REPO_FILES_UPLOAD.rejected],
    [413, REPO_FILES_UPLOAD.rejected],
    [409, REPO_FILES_UPLOAD.retry],
    [503, REPO_FILES_UPLOAD.retry],
    [new Error('ECONNREFUSED'), REPO_FILES_UPLOAD.retry],
  ];
  // i/o secuencial: cada caso con su plataforma.
  for (const [answer, outcome] of cases) {
    const { platform, posted } = platformAnswering(answer);
    assert.equal(await platform.repoFiles(body), outcome, String(answer));
    assert.deepEqual(posted, [[RUNNER_REPO_FILES_PATH, body]]);
  }
});

// --- el índice de una plataforma ---

// subidas falsas: cada una saca el siguiente resultado (sin más, ok) y apunta el cuerpo.
function uploader(outcomes: RepoFilesOutcome[] = []): { bodies: RunnerRepoFiles[]; upload: (b: RunnerRepoFiles) => Promise<RepoFilesOutcome> } {
  const bodies: RunnerRepoFiles[] = [];
  return { bodies, upload: async (b) => (bodies.push(b), outcomes.shift() ?? REPO_FILES_UPLOAD.ok) };
}

test('200: sube una vez; sin cambios no vuelve a mandarlo y con un fichero nuevo sí', async () => {
  const dir = fixtureRepo();
  const { bodies, upload } = uploader();
  const sync = new RepoFilesSync(upload, env);
  await sync.sync([{ repo: REPO, dir }]);
  await sync.sync([{ repo: REPO, dir }]);
  assert.equal(bodies.length, 1, 'la huella no cambió: sin petición');
  write(dir, 'later.ts');
  await sync.sync([{ repo: REPO, dir }]);
  assert.deepEqual([bodies.length, bodies[1]!.files.includes('later.ts')], [2, true]);
});

test('404 y 413 no se reintentan hasta que el índice cambie', async () => {
  // i/o secuencial: un caso tras otro.
  for (const outcome of [REPO_FILES_UPLOAD.unsupported, REPO_FILES_UPLOAD.rejected]) {
    const dir = fixtureRepo();
    const { bodies, upload } = uploader([outcome]);
    const sync = new RepoFilesSync(upload, env);
    assert.deepEqual(sync.due([REPO]), [REPO], 'la primera vuelta');
    await sync.sync([{ repo: REPO, dir }]);
    assert.deepEqual(sync.due([REPO], Date.now() + REPO_FILES_RETRY_MS), [], `${outcome}: sin reintento pendiente`);
    await sync.sync([{ repo: REPO, dir }]);
    assert.equal(bodies.length, 1, `${outcome}: el mismo índice no se vuelve a mandar`);
    write(dir, 'later.ts');
    await sync.sync([{ repo: REPO, dir }]);
    assert.equal(bodies.length, 2, `${outcome}: cambió, se manda`);
  }
});

test('409: se reintenta con un claim pasado REPO_FILES_RETRY_MS, no antes', async () => {
  const { bodies, upload } = uploader([REPO_FILES_UPLOAD.retry]);
  const sync = new RepoFilesSync(upload, env);
  const t0 = Date.now();
  assert.deepEqual(sync.due([REPO], t0), [REPO], 'la primera vuelta');
  await sync.sync([{ repo: REPO, dir: repo }]);
  assert.deepEqual(sync.due([REPO], Date.now()), [], 'antes de tiempo');
  assert.deepEqual(sync.due([REPO], Date.now() + REPO_FILES_RETRY_MS), [REPO]);
  await sync.sync([{ repo: REPO, dir: repo }]);
  assert.equal(bodies.length, 2);
  assert.deepEqual(sync.due([REPO], Date.now() + 2 * REPO_FILES_RETRY_MS), [], 'guardado: ya no hay reintento');
});

test('due: todos en la primera vuelta y cada REPO_FILES_REFRESH_MS; entre medias, solo los nuevos', async () => {
  const sync = new RepoFilesSync(uploader().upload, env);
  const t0 = Date.now();
  assert.deepEqual(sync.due(['acme/a', 'acme/b'], t0), ['acme/a', 'acme/b']);
  assert.deepEqual(sync.due(['acme/a', 'acme/b'], t0 + 1), [], 'aún no se intentaron, pero ya están pedidos en esta vuelta');
  await sync.sync([{ repo: 'acme/a', dir: repo }]);
  assert.deepEqual(sync.due(['acme/a', 'acme/c'], t0 + 2), ['acme/c'], 'uno que se anuncia ahora');
  assert.deepEqual(sync.due(['acme/a', 'acme/c'], t0 + REPO_FILES_REFRESH_MS), ['acme/a', 'acme/c']);
});

test('un repo que no se puede listar se salta con un log (una vez) y no frena a los demás', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { bodies, upload } = uploader();
  const sync = new RepoFilesSync(upload, env);
  const plain = fs.mkdtempSync(path.join(root, 'plain-'));
  await sync.sync([{ repo: 'acme/plain', dir: plain }, { repo: REPO, dir: repo }]);
  await sync.sync([{ repo: 'acme/plain', dir: plain }]);
  assert.deepEqual(bodies.map((b) => b.repo), [REPO]);
  assert.equal(warn.mock.callCount(), 1, 'el mismo error no se repite');
});

test('una subida a la vez: lo que llega con una vuelta en marcha entra en ella, un repo tras otro', async () => {
  let inFlight = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const order: string[] = [];
  const sync = new RepoFilesSync(async (b) => {
    order.push(b.repo);
    peak = Math.max(peak, ++inFlight);
    await gate;
    inFlight--;
    return REPO_FILES_UPLOAD.ok;
  }, env);
  const first = sync.sync([{ repo: 'acme/a', dir: repo }]);
  await sync.sync([{ repo: 'acme/b', dir: repo }]);
  assert.deepEqual(sync.due(['acme/c']), [], 'con una vuelta en marcha no pide más');
  release();
  await first;
  assert.deepEqual([order, peak], [['acme/a', 'acme/b'], 1]);
});

// --- el daemon ---

test('el daemon sube el índice tras el primer claim con respuesta, del checkout del mapa', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = fs.mkdtempSync(path.join(root, 'daemon-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  const cfg: RunnerConfig = { baseUrl: 'https://duckhunt.test', clientId: 'c1', refreshToken: 'r1', label: 'fa', repos: { [REPO]: { path: repo } }, aws: {}, defaults: {} };
  fs.writeFileSync(configPath(), JSON.stringify(cfg), { mode: 0o600 });
  const { factories, created } = fakeFactories();
  const d = internals(loadConfig()!, { factories });
  await d.reloadConfig();
  const legacy = legacyOf(d);
  const platform = created.get(LEGACY_PLATFORM_ID)!;
  const bodies: RunnerRepoFiles[] = [];
  let uploaded!: () => void;
  const firstUpload = new Promise<void>((resolve) => (uploaded = resolve));
  Object.assign(platform, {
    repoFiles: async (b: RunnerRepoFiles): Promise<RepoFilesOutcome> => {
      bodies.push(b);
      uploaded();
      return REPO_FILES_UPLOAD.ok;
    },
  });
  platform.claims = [UNAVAILABLE];
  await d.pollOnce(legacy);
  assert.equal(bodies.length, 0, 'sin respuesta del server: su mapa puede no tener el repo');
  await d.pollOnce(legacy);
  await firstUpload;
  assert.deepEqual(bodies.map((b) => b.repo), [REPO]);
  assert.ok(bodies[0]!.files.includes('src/a.ts') && !bodies[0]!.files.includes('debug.log'));
});
