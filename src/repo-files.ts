// índice de ficheros de los repos de la máquina (t#678; el contrato, en el protocolo: repo-files.ts): lo que el composer
// de duckhunt autocompleta tras `@`. el cli expande `@ruta` solo, así que el prompt viaja igual: el daemon solo sube esto.
// decisiones:
// - la fuente es el checkout del mapa (`git ls-files -z --cached --others --exclude-standard`: lo versionado y lo nuevo
//   sin ignorar), nunca el worktree conv-<id> de una conversación: la landing y el hilo ven el mismo índice.
// - la forma: sin repetidas (un conflicto lista la ruta por etapa), sin directorios (un repo anidado sin versionar sale
//   como `dir/`), sin rutas de más de REPO_FILE_PATH_MAX_CHARS ni con controles, `"` o `\` (json las escaparía y el server
//   las descarta). lo menos profundo primero y luego por orden alfabético; se recorta a REPO_FILES_MAX rutas y a un
//   cuerpo de REPO_FILES_BODY_MAX_BYTES, con `truncated` si sobró algo. sin escapes, el peso de cada ruta en el json se
//   sabe sin serializar.
// - un índice POR PLATAFORMA (RepoFilesSync), solo en memoria: la huella sha256 de lo que su server ya tiene por repo,
//   así sin cambios no hay petición. tras reiniciar se vuelve a mandar todo una vez (el server dice si cambió).
// - cuándo: tras un claim aceptado, la vuelta entera la primera vez y cada REPO_FILES_REFRESH_MS, más los reintentos
//   que tocan; tras cada segmento, el de su repo. una subida a la vez por plataforma, un repo tras otro.
// - lo que responde el server: ok; 404 (server anterior a la ruta) y 400/413 (ese índice no lo acepta) no se reintentan
//   hasta que el índice cambie; 409 (la máquina o el repo aún no están en su mapa), 5xx o la red, tras
//   REPO_FILES_RETRY_MS y con otro claim.
// - nunca tumba un run: un repo que no se puede listar (no es un checkout, git tarda de más) es una línea de log (una vez
//   por error distinto) y se salta.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  REPO_FILE_PATH_MAX_CHARS,
  REPO_FILES_BODY_MAX_BYTES,
  REPO_FILES_MAX,
  REPO_FILES_REFRESH_MS,
  type RunnerRepoFiles,
} from './vendor/runner-protocol/index.js';

const execFileP = promisify(execFile);

const LS_FILES_ARGS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
const LS_FILES_TIMEOUT_MS = 30_000;
// la salida entera de un repo enorme (~1M rutas); por encima, git se corta y el repo se salta.
const LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;
const NUL = '\0';
const PATH_SEP = '/';
// lo que json escaparía (y cambiaría el peso de la ruta): controles, surrogates sueltos, comillas y barra invertida.
const UNSAFE_PATH_RE = /[\p{Cc}\p{Cs}"\\]/u;
// lo que suma cada ruta al cuerpo además de sus bytes: sus dos comillas y la coma que la separa de la anterior.
const QUOTE_BYTES = 2;
const COMMA_BYTES = 1;
// un fallo que se puede reintentar (409, 5xx, red) no se reintenta antes de esto.
export const REPO_FILES_RETRY_MS = 60_000;

/** topes del índice de un repo (los del protocolo; los tests los bajan). */
export interface RepoFilesLimits {
  files: number;
  bodyBytes: number;
  pathChars: number;
}
export const REPO_FILES_LIMITS: RepoFilesLimits = { files: REPO_FILES_MAX, bodyBytes: REPO_FILES_BODY_MAX_BYTES, pathChars: REPO_FILE_PATH_MAX_CHARS };

/** resultado de una subida: guardada, server sin la ruta, índice que el server no acepta (400/413) o fallo que se
 *  reintenta (409, 5xx, red). las tres primeras no se vuelven a mandar hasta que el índice cambie. */
export const REPO_FILES_UPLOAD = { ok: 'ok', unsupported: 'unsupported', rejected: 'rejected', retry: 'retry' } as const;
export type RepoFilesOutcome = (typeof REPO_FILES_UPLOAD)[keyof typeof REPO_FILES_UPLOAD];
export type RepoFilesUploader = (body: RunnerRepoFiles) => Promise<RepoFilesOutcome>;

// --- el índice de un repo ---

const usable = (max: number) => (p: string): boolean => p.length > 0 && p.length <= max && !p.endsWith(PATH_SEP) && !UNSAFE_PATH_RE.test(p);
const depthOf = (p: string): number => p.split(PATH_SEP).length;
const byDepthThenName = (a: readonly [number, string], b: readonly [number, string]): number => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

// cuántas rutas, en orden, caben en `budget` bytes (la primera sin coma delante).
function fitting(paths: readonly string[], budget: number): number {
  let used = -COMMA_BYTES;
  const over = paths.findIndex((p) => (used += Buffer.byteLength(p) + QUOTE_BYTES + COMMA_BYTES) > budget);
  return over < 0 ? paths.length : over;
}

/** el cuerpo de un repo a partir de lo que listó git: filtrado, ordenado y recortado a los topes. */
export function buildRepoFiles(repo: string, listed: readonly string[], limits: RepoFilesLimits = REPO_FILES_LIMITS): RunnerRepoFiles {
  const kept = Array.from(new Set(listed)).filter(usable(limits.pathChars));
  const sorted = kept
    .map((p) => [depthOf(p), p] as const)
    .sort(byDepthThenName)
    .map(([, p]) => p)
    .slice(0, limits.files);
  // el cuerpo vacío con `false` (un byte más que `true`): lo que quede cabe seguro.
  const budget = limits.bodyBytes - Buffer.byteLength(JSON.stringify({ repo, files: [], truncated: false }));
  const files = sorted.slice(0, fitting(sorted, budget));
  return { repo, files, truncated: files.length < kept.length };
}

/** lo que git lista en `dir`: lo versionado y lo nuevo sin ignorar. lanza si no es un checkout o git tarda de más. */
export async function listRepoFiles(dir: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const { stdout } = await execFileP('git', ['-C', dir, ...LS_FILES_ARGS], { env, timeout: LS_FILES_TIMEOUT_MS, maxBuffer: LS_FILES_MAX_BUFFER, encoding: 'utf8' });
  return stdout.split(NUL);
}

// --- el índice de una plataforma y su subida ---

/** un repo que indexar y su checkout del mapa. */
export interface RepoCheckout {
  repo: string;
  dir: string;
}

interface RepoState {
  // la huella de lo que ya tiene el server (o de lo que no hay que volver a mandarle); null = nada aún.
  uploaded: string | null;
  // cuándo reintentar un fallo; null = sin reintento pendiente.
  retryAt: number | null;
  // el último error al listarlo (solo se loguea uno distinto).
  error: string | null;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** el índice de los repos de una plataforma: qué toca subir y la subida, una a la vez. */
export class RepoFilesSync {
  private readonly states = new Map<string, RepoState>();
  private readonly queue = new Map<string, string>();
  private roundAt = -Infinity;
  private running = false;

  constructor(
    private readonly upload: RepoFilesUploader,
    private readonly env: NodeJS.ProcessEnv,
    private readonly limits: RepoFilesLimits = REPO_FILES_LIMITS,
  ) {}

  /** de los repos que anunció su último claim aceptado, los que tocan ahora: todos en la primera vuelta y cada
   *  REPO_FILES_REFRESH_MS; si no, los nuevos y los fallos cuyo reintento venció. con una vuelta en marcha, ninguno.
   *  los que devuelve quedan pedidos: no vuelven a salir hasta la siguiente vuelta o un fallo nuevo. */
  due(announced: readonly string[], now = Date.now()): string[] {
    if (this.running) return [];
    const round = now - this.roundAt >= REPO_FILES_REFRESH_MS;
    if (round) this.roundAt = now;
    const picked = announced.filter((repo) => {
      const s = this.states.get(repo);
      return round || !s || (s.retryAt !== null && now >= s.retryAt);
    });
    picked.forEach((repo) => (this.stateOf(repo).retryAt = null));
    return picked;
  }

  /** indexa y sube estos repos uno tras otro (lo que llega con una vuelta en marcha entra en ella). nunca lanza. */
  async sync(checkouts: readonly RepoCheckout[]): Promise<void> {
    checkouts.forEach(({ repo, dir }) => this.queue.set(repo, dir));
    if (this.running) return;
    this.running = true;
    try {
      // i/o secuencial: una subida a la vez por plataforma; el Map recorre también lo que entra durante la vuelta.
      for (const [repo, dir] of this.queue) {
        this.queue.delete(repo);
        await this.syncOne(repo, dir);
      }
    } finally {
      this.running = false;
    }
  }

  private stateOf(repo: string): RepoState {
    const known = this.states.get(repo);
    if (known) return known;
    const fresh: RepoState = { uploaded: null, retryAt: null, error: null };
    this.states.set(repo, fresh);
    return fresh;
  }

  private async syncOne(repo: string, dir: string): Promise<void> {
    const state = this.stateOf(repo);
    let body: RunnerRepoFiles;
    try {
      body = buildRepoFiles(repo, await listRepoFiles(dir, this.env), this.limits);
      state.error = null;
    } catch (err) {
      // la primera línea de lo que dijo git (o del error de node: el timeout, el maxBuffer).
      const e = err as Error & { stderr?: string };
      const message = (e.stderr?.trim() || e.message).split('\n')[0]!;
      if (message !== state.error) console.warn(`[runner] índice de ${repo}: no se pudo listar su checkout (${message}); se salta`);
      state.error = message;
      state.retryAt = null;
      return;
    }
    const hash = sha256(JSON.stringify(body));
    if (state.uploaded === hash) {
      state.retryAt = null;
      return;
    }
    const outcome = await this.upload(body).catch((err: Error) => {
      // la plataforma no debería lanzar; si lo hace, se reintenta como un fallo de red.
      console.error(`[runner] índice de ${repo}: ${err.message}`);
      return REPO_FILES_UPLOAD.retry;
    });
    if (outcome === REPO_FILES_UPLOAD.retry) {
      state.retryAt = Date.now() + REPO_FILES_RETRY_MS;
      return;
    }
    state.uploaded = hash;
    state.retryAt = null;
    if (outcome === REPO_FILES_UPLOAD.ok && body.truncated) console.warn(`[runner] índice de ${repo}: recortado a ${body.files.length} rutas por los topes`);
  }
}
