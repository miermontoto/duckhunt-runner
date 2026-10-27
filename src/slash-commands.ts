// catálogo de slash commands de la máquina (t#555; el contrato, en el protocolo: slash-commands.ts): lo que los runs de
// claude pueden invocar con la tool Skill, con su descripción, para el autocompletado `/` del composer de duckhunt.
// decisiones:
// - la verdad es el `system/init` de cada segmento (slash_commands, skills, plugins con su ruta): el daemon no imita el
//   descubrimiento del cli. de sus nombres se quedan las skills y los comandos con fichero; los built-ins (clear,
//   compact, model…) salen en slash_commands sin fichero, no son skills y Skill no los ejecuta.
// - descripción y argument-hint salen del frontmatter del fichero (sin descripción, la primera línea del cuerpo de un
//   comando), en una línea, enmascarados (maskSecrets) y recortados. solo se lee un fichero cuyo realpath nativo queda
//   dentro de su directorio, y solo sus primeros FRONTMATTER_READ_BYTES: un repo puede commitear
//   `.claude/commands/x.md` → ~/.aws/credentials y su primera línea saldría de la máquina.
// - ámbitos: user (la config del usuario), plugin (los del init), bundled (skills del init sin fichero: las del cli) y
//   project (el .claude del cwd, que solo carga un segmento en edición: los de lectura van con --setting-sources user).
//   la lista del usuario sale del último segmento de lectura (o, sin ninguno aún, del último de edición: un plugin
//   activado solo en un proyecto se colaría ahí, se acepta) y la del proyecto de un repo, del último de edición en él.
// - se guarda en <runnerHome>/slash-commands.json (sobrevive a reinicios: la landing tiene comandos antes del primer
//   run) y se sube entero a cada plataforma que lo admite cuando cambia lo que ella tiene (huella sha256), con un
//   reintento espaciado si falla y sin reintentar ante un server que no conoce la ruta hasta que el catálogo cambie.
// - nunca tumba un run: un fichero ilegible es un comando sin descripción; un fallo al guardar o al subir, un log.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskSecrets } from './secret-mask.js';
import {
  SLASH_COMMAND_ARGUMENT_HINT_MAX_CHARS,
  SLASH_COMMAND_DESCRIPTION_MAX_CHARS,
  SLASH_COMMAND_NAME_RE,
  SLASH_COMMAND_REPOS_MAX,
  SLASH_COMMAND_SCOPE,
  SLASH_COMMANDS_MAX,
  type RunnerSlashCommands,
  type SlashCommand,
  type SlashCommandScope,
} from './vendor/runner-protocol/index.js';

// bytes que se leen de cada fichero (el frontmatter y la primera línea del cuerpo caben de sobra).
const FRONTMATTER_READ_BYTES = 8192;
const COMMANDS_DIR = 'commands';
const SKILLS_DIR = 'skills';
const SKILL_FILE = 'SKILL.md';
const MD_EXT = '.md';
// .claude del proyecto (el cwd del segmento) y la config del usuario por defecto.
const PROJECT_CONFIG_DIR = '.claude';
const USER_CONFIG_DIR = '.claude';
// subcarpetas de commands/ que se recorren (comandos anidados: commands/frontend/x.md).
const COMMANDS_MAX_DEPTH = 3;
// separador de un nombre con espacio: `plugin:comando` o `carpeta:comando`.
const NAME_SEP = ':';
// un fallo al subir (red, 5xx, 409 sin fila aún) no se reintenta antes de esto; el claim lo vuelve a intentar.
export const SLASH_COMMANDS_RETRY_MS = 60_000;
const STORE_VERSION = 1;
const STORE_MODE = 0o600;
const JSON_INDENT = 2;

/** lo que el init de un segmento dice que se cargó. */
export interface InitCatalog {
  slashCommands: string[];
  skills: string[];
  plugins: { name: string; path: string }[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : []);
const isPlugin = (v: unknown): v is { name: string; path: string } =>
  typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string' && typeof (v as { path?: unknown }).path === 'string';

/** catálogo de un evento system/init; null si no trae slash_commands (un cli anterior). */
export function parseInitCatalog(ev: { slash_commands?: unknown; skills?: unknown; plugins?: unknown }): InitCatalog | null {
  if (!Array.isArray(ev.slash_commands)) return null;
  return {
    slashCommands: strings(ev.slash_commands),
    skills: strings(ev.skills),
    plugins: Array.isArray(ev.plugins) ? ev.plugins.filter(isPlugin).map((p) => ({ name: p.name, path: p.path })) : [],
  };
}

// --- ayuda de un comando: frontmatter mínimo ---

interface CommandHelp {
  description: string | null;
  argumentHint: string | null;
}

// una línea, sin controles, enmascarada y recortada; vacía = null.
function oneLine(v: string | null | undefined, max: number): string | null {
  const flat = v?.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return flat ? maskSecrets(flat).slice(0, max) : null;
}

const unquote = (v: string): string => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v);

// claves `clave: valor` del frontmatter (yaml mínimo): valor en la línea, con o sin comillas, o un bloque `>`/`|` de
// líneas indentadas, unidas con espacios.
function frontmatterFields(src: string): Record<string, string> {
  const lines = src.split(/\r?\n/);
  return Object.fromEntries(
    lines.flatMap((line, i): [string, string][] => {
      const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!m) return [];
      const raw = m[2]!.trim();
      if (!/^[>|][-+]?$/.test(raw)) return [[m[1]!, unquote(raw)]];
      const rest = lines.slice(i + 1);
      const end = rest.findIndex((l) => l.trim() !== '' && !/^\s/.test(l));
      return [[m[1]!, (end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim()).join(' ')]];
    }),
  );
}

/** descripción y argument-hint de un fichero de comando o skill; sin frontmatter con descripción, la primera línea
 *  del cuerpo si `bodyFallback` (los comandos; una skill sin descripción no tiene ayuda). */
export function parseCommandHelp(text: string, bodyFallback: boolean): CommandHelp {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = fm ? frontmatterFields(fm[1]!) : {};
  const body = fm ? text.slice(fm[0].length) : text;
  const first = bodyFallback
    ? body
        .split(/\r?\n/)
        .map((l) => l.replace(/^#+\s*/, '').trim())
        .find((l) => l.length > 0)
    : undefined;
  return {
    description: oneLine(fields.description || first, SLASH_COMMAND_DESCRIPTION_MAX_CHARS),
    argumentHint: oneLine(fields['argument-hint'], SLASH_COMMAND_ARGUMENT_HINT_MAX_CHARS),
  };
}

// --- ficheros de comandos y skills ---

interface CommandFile {
  file: string;
  // directorio del que no puede salir su realpath (commands/ o skills/ de esa raíz).
  base: string;
  skill: boolean;
}

// realpath nativo (como read-shell-guard.ts); null si no existe.
function realpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    // inexistente o colgante: ese directorio o fichero no aporta comandos (no es un error del run).
    return null;
  }
}

// primeros bytes de un fichero que de verdad vive dentro de `base`; null si sale de él o no se puede leer.
function readInside(f: CommandFile): string | null {
  const root = realpath(f.base);
  const real = realpath(f.file);
  if (!root || !real || (real !== root && !real.startsWith(root + path.sep))) return null;
  try {
    const fd = fs.openSync(real, 'r');
    try {
      const buf = Buffer.alloc(FRONTMATTER_READ_BYTES);
      return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    console.warn(`[runner] slash commands: no se pudo leer ${f.file}: ${(err as Error).message}`);
    return null;
  }
}

const listDir = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // sin ese directorio (lo normal en un repo sin .claude): sin comandos de esa raíz.
    return [];
  }
};

// commands/**/*.md hasta COMMANDS_MAX_DEPTH, con el nombre anidado (`carpeta:comando`) y el suelto (`comando`).
function commandEntries(dir: string, base: string, prefix: string[] = [], depth = 0): [string, CommandFile][] {
  return listDir(dir).flatMap((d): [string, CommandFile][] => {
    const full = path.join(dir, d.name);
    if (d.isDirectory() || (d.isSymbolicLink() && realpath(full) !== null && fs.statSync(full).isDirectory())) {
      return depth + 1 < COMMANDS_MAX_DEPTH ? commandEntries(full, base, [...prefix, d.name], depth + 1) : [];
    }
    if (!d.name.endsWith(MD_EXT)) return [];
    const name = d.name.slice(0, -MD_EXT.length);
    const file = { file: full, base, skill: false };
    return prefix.length > 0 ? [[[...prefix, name].join(NAME_SEP), file], [name, file]] : [[name, file]];
  });
}

/** comandos y skills de una raíz (la config del usuario, un plugin, el .claude del proyecto) por nombre. */
function indexRoot(root: string): Map<string, CommandFile> {
  const commands = path.join(root, COMMANDS_DIR);
  const skills = path.join(root, SKILLS_DIR);
  const skillEntries = listDir(skills)
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d): [string, CommandFile] => [d.name, { file: path.join(skills, d.name, SKILL_FILE), base: skills, skill: true }])
    .filter(([, f]) => fs.existsSync(f.file));
  // el primero gana: un comando anidado no pisa a uno de la raíz con el mismo nombre suelto.
  return [...commandEntries(commands, commands), ...skillEntries].reduce((m, [k, v]) => (m.has(k) ? m : m.set(k, v)), new Map<string, CommandFile>());
}

/** la config de claude code del usuario que carga el cli ($CLAUDE_CONFIG_DIR o ~/.claude). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), USER_CONFIG_DIR);
}

/** dónde buscar los ficheros: la config del usuario y, en un segmento de edición, el cwd (su .claude). */
export interface ResolveDirs {
  configDir: string;
  // null = el segmento no cargó los del proyecto (lectura) o no hay cwd.
  projectCwd: string | null;
}

/**
 * comandos invocables de un init, con su ayuda: las skills y los nombres con fichero, en el orden del init. un nombre
 * `plugin:x` se busca en ese plugin; uno suelto, en el proyecto (si se cargó) y luego en la config del usuario.
 */
export function resolveSlashCommands(init: InitCatalog, dirs: ResolveDirs): SlashCommand[] {
  const user = indexRoot(dirs.configDir);
  const project = dirs.projectCwd ? indexRoot(path.join(dirs.projectCwd, PROJECT_CONFIG_DIR)) : new Map<string, CommandFile>();
  const plugins = new Map(init.plugins.map((p) => [p.name, p.path]));
  const pluginIndex = new Map<string, Map<string, CommandFile>>();
  const pluginEntry = (name: string): CommandFile | null => {
    const [plugin, ...rest] = name.split(NAME_SEP);
    const root = plugins.get(plugin!);
    if (!root || rest.length === 0) return null;
    if (!pluginIndex.has(root)) pluginIndex.set(root, indexRoot(root));
    return pluginIndex.get(root)!.get(rest.join(NAME_SEP)) ?? null;
  };
  const skills = new Set(init.skills);
  // de dónde sale un nombre: su fichero con su ámbito, una skill sin fichero (la de un plugin o del cli) o nada (un
  // built-in, que Skill no ejecuta).
  const locate = (name: string): { scope: SlashCommandScope; file: CommandFile | null } | null => {
    const inPlugin = pluginEntry(name);
    if (inPlugin) return { scope: SLASH_COMMAND_SCOPE.plugin, file: inPlugin };
    const inProject = project.get(name);
    if (inProject) return { scope: SLASH_COMMAND_SCOPE.project, file: inProject };
    const inUser = user.get(name);
    if (inUser) return { scope: SLASH_COMMAND_SCOPE.user, file: inUser };
    if (!skills.has(name)) return null;
    return { scope: plugins.has(name.split(NAME_SEP)[0]!) ? SLASH_COMMAND_SCOPE.plugin : SLASH_COMMAND_SCOPE.bundled, file: null };
  };
  const resolve = (name: string): SlashCommand | null => {
    const found = locate(name);
    if (!found) return null;
    const text = found.file ? readInside(found.file) : null;
    const help = found.file && text !== null ? parseCommandHelp(text, !found.file.skill) : { description: null, argumentHint: null };
    return { name, scope: found.scope, ...help };
  };
  const names = Array.from(new Set([...init.slashCommands, ...init.skills])).filter((n) => SLASH_COMMAND_NAME_RE.test(n));
  return names.map(resolve).filter((c): c is SlashCommand => c !== null);
}

// --- el catálogo guardado y su subida ---

interface Stored {
  v: number;
  user: SlashCommand[];
  // la lista del usuario salió de un segmento de lectura (la exacta: solo carga los del usuario).
  userFromRead: boolean;
  repos: Record<string, SlashCommand[]>;
}

/** lo que se sube, con su huella. */
export interface SlashCommandsUpload {
  catalog: RunnerSlashCommands;
  hash: string;
}

/** resultado de una subida: guardada, servidor que no conoce la ruta (no reintentar) o fallo (reintentar). */
export const SLASH_UPLOAD = { ok: 'ok', unsupported: 'unsupported', failed: 'failed' } as const;
export type SlashUploadOutcome = (typeof SLASH_UPLOAD)[keyof typeof SLASH_UPLOAD];

const EMPTY: Stored = { v: STORE_VERSION, user: [], userFromRead: false, repos: {} };

function loadStored(file: string): Stored {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // sin fichero (primer arranque): catálogo vacío hasta el primer segmento.
    return EMPTY;
  }
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    if (v.v !== STORE_VERSION || !Array.isArray(v.user) || typeof v.repos !== 'object' || v.repos === null) return EMPTY;
    return { v: STORE_VERSION, user: v.user, userFromRead: v.userFromRead === true, repos: v.repos };
  } catch (err) {
    console.warn(`[runner] slash commands: ${file} ilegible, se rehace con el siguiente run: ${(err as Error).message}`);
    return EMPTY;
  }
}

/** el catálogo de la máquina: lo que registran los segmentos y lo que falta por subir a cada plataforma. */
export class SlashCommandCatalog {
  private stored: Stored;
  // por plataforma: la huella que ya tiene y cuándo falló la última subida.
  private readonly uploaded = new Map<string, string>();
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly file: string) {
    this.stored = loadStored(file);
  }

  /** registra lo que cargó un segmento; true si el catálogo cambió (y entonces lo guarda). */
  record(seg: { edit: boolean; repo: string | null; commands: readonly SlashCommand[] }): boolean {
    const userCmds = seg.commands.filter((c) => c.scope !== SLASH_COMMAND_SCOPE.project).slice(0, SLASH_COMMANDS_MAX);
    const projectCmds = seg.commands.filter((c) => c.scope === SLASH_COMMAND_SCOPE.project).slice(0, SLASH_COMMANDS_MAX);
    const takeUser = !seg.edit || !this.stored.userFromRead;
    // en edición con repo, los del proyecto de ese repo se reemplazan (sin ninguno, el repo sale del catálogo).
    const otherRepos = Object.fromEntries(Object.entries(this.stored.repos).filter(([repo]) => repo !== seg.repo));
    const repos = seg.edit && seg.repo ? { ...otherRepos, ...(projectCmds.length > 0 ? { [seg.repo]: projectCmds } : {}) } : this.stored.repos;
    const next: Stored = {
      v: STORE_VERSION,
      user: takeUser ? userCmds : this.stored.user,
      userFromRead: this.stored.userFromRead || !seg.edit,
      repos: Object.fromEntries(Object.entries(repos).slice(-SLASH_COMMAND_REPOS_MAX)),
    };
    if (JSON.stringify(next) === JSON.stringify(this.stored)) return false;
    this.stored = next;
    this.save();
    return true;
  }

  /** lo que hay que subir a la plataforma `id` (null si ya lo tiene, si está vacío o si falló hace poco). */
  pendingFor(id: string, now = Date.now()): SlashCommandsUpload | null {
    if (this.stored.user.length === 0 && Object.keys(this.stored.repos).length === 0) return null;
    const catalog: RunnerSlashCommands = { user: this.stored.user, repos: Object.entries(this.stored.repos).map(([repo, commands]) => ({ repo, commands })) };
    const hash = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
    if (this.uploaded.get(id) === hash) return null;
    if (now - (this.failedAt.get(id) ?? -Infinity) < SLASH_COMMANDS_RETRY_MS) return null;
    return { catalog, hash };
  }

  /** apunta cómo fue la subida de `hash` a la plataforma `id`. */
  settle(id: string, hash: string, outcome: SlashUploadOutcome, now = Date.now()): void {
    if (outcome === SLASH_UPLOAD.failed) {
      this.failedAt.set(id, now);
      return;
    }
    // guardada, o un server que no conoce la ruta: no se vuelve a mandar hasta que el catálogo cambie.
    this.uploaded.set(id, hash);
    this.failedAt.delete(id);
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.stored, null, JSON_INDENT), { mode: STORE_MODE });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[runner] slash commands: no se pudo guardar ${this.file}: ${(err as Error).message}`);
    }
  }
}
