// la shell de solo lectura del cli (t#385) solo en un cwd del que una lectura recursiva no pueda salir
// (t#465). verificado con el cli 2.1.296 y el argv del daemon (sondas de la revisión de P6): la shell
// que el cli auto-aprueba en dontAsk no sale del cwd y honra el deny de una ruta nombrada, pero una
// lectura recursiva no honra los Read negados: `grep -r x .` lee un fichero vetado que esté dentro y
// `grep -R` sigue los symlinks, así que una rama que commitee un symlink hacia ~ (o hacia /) deja leer
// ~/.aws, la config del runner… las tools Read/Grep/Glob sí honran los deny en recursivo y a través
// de symlinks, así que sin shell el kit de lectura sigue entero (re-sondeado en 0.10.2 con el daemon
// real: sin el guard `grep -R` leyó un secreto falso vetado a través del symlink; con él el cli ni
// ofrece Bash y el Grep de la tool no lo encuentra).
// regla: antes de cada segmento cuyo kit tiene esa shell (hasReadShell: Bash ni entera en el allow ni
// negada, ni una tool de escritura permitida; un kit de edición nunca la tiene), el daemon lista los
// symlinks COMMITEADOS del cwd (`git ls-files --stage`, modo 120000, submódulos incluidos: lee el
// índice, barato hasta en checkouts grandes) y los de los worktrees del daemon que viven dentro
// (.duckhunt/worktrees/* de un checkout: ramas que cualquiera pudo empujar). vale igual para worktree
// y checkout, y para conversaciones libres y plantillas. un symlink sale si su destino léxico
// (readlink contra su directorio) o su realpath (si existe) cae fuera del realpath del cwd; uno
// colgante que sale cuenta (su destino puede aparecer). el realpath es SIEMPRE el nativo (realpath(3),
// fs.realpathSync.native): el de js colapsa los `..` de un destino a mano, y el kernel los resuelve
// tras seguir cada symlink, así que un `..` detrás de un symlink interno se leía "dentro" y salía
// (revisión de 0.10.2). también va sin shell un cwd que contiene el home del usuario o el estado del
// runner (un repo mapeado en ~): ahí todo está "dentro".
// con alguno, ese segmento va sin shell: Bash entera al deny y ningún Bash(...) en el allow (tampoco
// la aws cli; claude-args.ts::withoutShell). fail-closed: si git no puede listar un checkout (o un
// nombre no se puede decodificar, o un directorio de .duckhunt/worktrees/ con contenido no es un
// worktree: alguien le borró el .git y lo que trajo su rama ya no sale en ningún índice), sin shell.
// los paths solo van al log local; al feed, el recuento.
// fuera de alcance: symlinks sin commitear ni en el índice o ignorados (en el checkout los puso el
// usuario; en un worktree de conversación, solo un segmento de edición previo, verificado, con Bash
// entera; uno que ese segmento metió en el índice sí cuenta), clones anidados que no son submódulos,
// el scratch (no es un checkout: lo que haya dentro lo puso el usuario o un run de edición) y un
// symlink commiteado que el disco tiene como otra cosa (con core.symlinks=false git lo escribe como
// fichero de texto y grep no lo sigue). residual conocido: el escaneo es al empezar el segmento; un
// worktree de otra conversación que se crea DENTRO de un checkout mientras un segmento de lectura
// corre en ese checkout (otro slot) no se revisa hasta su siguiente segmento. cerrarlo pide sacar los
// worktrees del checkout (0.11).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASH_TOOL, READ_FORBIDDEN_TOOLS } from './claim.js';
import { configPath, runnerHome } from './config.js';
import { worktreesDir } from './worktree.js';

// modo git de un symlink en el índice.
const GIT_SYMLINK_MODE = '120000';
// entrada que hace de un directorio un worktree (fichero gitdir) o un repo.
const GIT_ENTRY = '.git';
// --stage da `<modo> <objeto> <etapa>\t<ruta>`; -z separa con NUL sin entrecomillar las rutas.
const LS_FILES_ARGS = ['ls-files', '--stage', '-z', '--recurse-submodules'];
// listar el índice no tarda ni un segundo; un git colgado no debe retener el segmento.
const LS_FILES_TIMEOUT_MS = 60_000;
const STDERR_MAX_CHARS = 2000;
// carácter que deja el decoder utf-8 en un nombre que no lo es: esa ruta no se puede comprobar.
const UNDECODABLE = '�';
// errores de lstat/realpath que significan "no hay nada que seguir ahí".
const GONE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);
// symlinks que se detallan en el log local (el resto se resume en el recuento).
const LOG_MAX_LINKS = 20;

/** tools de un kit (las de ClaimResponse.tools). */
export interface ShellKit {
  allowed: readonly string[];
  disallowed: readonly string[];
}

/** symlink commiteado que sale del cwd: ruta relativa al cwd y su destino tal cual (solo para el log local). */
export interface EscapingSymlink {
  path: string;
  target: string;
}

export interface ReadShellVerdict {
  // true = el segmento va sin shell.
  dropShell: boolean;
  escaping: EscapingSymlink[];
  // rutas sensibles (home, estado del runner) que caen dentro del cwd.
  contains: string[];
  // git no pudo listar un checkout: sin shell por si acaso.
  error: string | null;
}

const KEEP: ReadShellVerdict = { dropShell: false, escaping: [], contains: [], error: null };

const grants = (tools: ShellKit, tool: string): boolean => tools.allowed.some((t) => t === tool || t.startsWith(`${tool}(`));

/** true si el kit tiene la shell de solo lectura del cli: Bash ni permitida entera ni negada (también por el deny espejado) y ninguna tool de escritura permitida. */
export function hasReadShell(tools: ShellKit, extraDeny: readonly string[] = []): boolean {
  return (
    !tools.allowed.includes(BASH_TOOL) &&
    !tools.disallowed.includes(BASH_TOOL) &&
    !extraDeny.includes(BASH_TOOL) &&
    !READ_FORBIDDEN_TOOLS.some((tool) => grants(tools, tool))
  );
}

/** true si `p` es `root` o cuelga de él (ambos absolutos y resueltos). */
export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// realpath nativo (el del kernel, ver cabecera) o null si no hay a dónde llegar (colgante, bucle).
function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    if (GONE_CODES.has((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  }
}

// destino de `abs` si es un symlink que sale de `root`; null si no es un symlink en disco o no sale.
function escapingTarget(root: string, abs: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch (err) {
    // borrado en local (o un padre que ya no es directorio): no hay symlink que seguir.
    if (GONE_CODES.has((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  }
  if (!stat.isSymbolicLink()) return null;
  const target = fs.readlinkSync(abs);
  if (!isInside(root, path.resolve(path.dirname(abs), target))) return target;
  const real = realpathOrNull(abs);
  return real !== null && !isInside(root, real) ? target : null;
}

// rutas (relativas a `dir`) de los symlinks del índice de `dir` y de sus submódulos activos.
function trackedSymlinks(dir: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', LS_FILES_ARGS, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const found: string[] = [];
    let rest = '';
    let stderr = '';
    const take = (record: string): void => {
      if (record.startsWith(`${GIT_SYMLINK_MODE} `)) found.push(record.slice(record.indexOf('\t') + 1));
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), LS_FILES_TIMEOUT_MS);
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      const records = `${rest}${chunk}`.split('\0');
      rest = records.pop() ?? '';
      records.forEach(take);
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_MAX_CHARS);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`no se pudo lanzar git ls-files: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`git ls-files falló en ${dir} (${signal ?? `código ${code}`}): ${stderr.trim().split('\n')[0] ?? ''}`));
        return;
      }
      take(rest);
      resolve(found);
    });
  });
}

// worktrees del daemon dentro de `root` (un checkout con conversaciones abiertas en worktree). lanza
// si uno con contenido ya no es un worktree (sin .git): git no listaría lo que trajo su rama.
function daemonWorktreesIn(root: string): string[] {
  const dir = worktreesDir(root);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const trees = entries.filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  const orphan = trees.find((tree) => !fs.existsSync(path.join(tree, GIT_ENTRY)) && fs.readdirSync(tree).length > 0);
  if (orphan !== undefined) throw new Error(`${path.relative(root, orphan)} tiene contenido pero no es un worktree git: no se pueden revisar sus symlinks`);
  return trees.filter((tree) => fs.existsSync(path.join(tree, GIT_ENTRY)));
}

/** symlinks commiteados del cwd (y de los worktrees del daemon que viven dentro) que salen del cwd. lanza si git no puede listar alguno. */
export async function escapingSymlinks(cwd: string, env: NodeJS.ProcessEnv): Promise<EscapingSymlink[]> {
  const root = fs.realpathSync.native(cwd);
  const found = new Map<string, EscapingSymlink>();
  // i/o secuencial: un git a la vez, sin competir con los runs en paralelo.
  for (const tree of [root, ...daemonWorktreesIn(root)]) {
    const links = await trackedSymlinks(tree, env);
    links
      .map((rel) => path.join(tree, rel))
      .map((abs): EscapingSymlink | null => {
        // un nombre que no es utf-8 no se puede resolver: cuenta como que sale.
        if (abs.includes(UNDECODABLE)) return { path: path.relative(root, abs), target: '?' };
        const target = escapingTarget(root, abs);
        return target === null ? null : { path: path.relative(root, abs), target };
      })
      .filter((l): l is EscapingSymlink => l !== null)
      .forEach((l) => found.set(l.path, l));
  }
  return [...found.values()];
}

// rutas que ninguna lectura recursiva debe alcanzar: el home (credenciales) y el estado del runner.
function sensitivePaths(): string[] {
  return Array.from(new Set([os.homedir(), runnerHome(), configPath()].map((p) => realpathOrNull(p) ?? path.resolve(p))));
}

/**
 * ¿puede este segmento llevar la shell de lectura? solo se mira si el kit la tiene y el cwd es un
 * checkout (cwd null = scratch): sensibles dentro del cwd o symlinks commiteados que salen → sin shell.
 */
export async function readShellGuard(cwd: string | null, tools: ShellKit, extraDeny: readonly string[], env: NodeJS.ProcessEnv): Promise<ReadShellVerdict> {
  if (cwd === null || !hasReadShell(tools, extraDeny)) return KEEP;
  try {
    const root = fs.realpathSync.native(cwd);
    const contains = sensitivePaths().filter((p) => isInside(root, p));
    const escaping = await escapingSymlinks(root, env);
    return { dropShell: contains.length > 0 || escaping.length > 0, escaping, contains, error: null };
  } catch (err) {
    return { dropShell: true, escaping: [], contains: [], error: (err as Error).message };
  }
}

/** nota para el feed (sin paths: viaja al server). null si el segmento conserva la shell. */
export function readShellNote(v: ReadShellVerdict): string | null {
  if (!v.dropShell) return null;
  if (v.error !== null) return 'sin shell de lectura en este turno: no se pudieron revisar los symlinks del repo';
  if (v.contains.length > 0) return 'sin shell de lectura en este turno: el directorio de trabajo contiene tu home o el estado del runner';
  return `sin shell de lectura en este turno: ${v.escaping.length} symlink(s) commiteado(s) apuntan fuera del directorio de trabajo`;
}

/** detalle para el log local (con paths, nunca sale de la máquina). null si el segmento conserva la shell. */
export function readShellLog(v: ReadShellVerdict): string | null {
  if (!v.dropShell) return null;
  if (v.error !== null) return v.error;
  const links = v.escaping.slice(0, LOG_MAX_LINKS).map((l) => `${l.path} → ${l.target}`);
  const more = v.escaping.length > LOG_MAX_LINKS ? [`y ${v.escaping.length - LOG_MAX_LINKS} más`] : [];
  return [...v.contains.map((p) => `contiene ${p}`), ...links, ...more].join(', ');
}
