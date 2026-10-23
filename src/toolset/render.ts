// render de toolset_v1 a las listas de tools de claude code (t#495, M5): el claude-code-kit.ts del server, portado
// al daemon, que es quien sabe de su backend. hoy corre en sombra (shadow.ts): las listas que mandan siguen siendo
// las del claim; tras el flip saldrán de aquí.
// allow: leer el repo (Read/Grep/Glob) + Bash entero con shell full + Edit/Write si escribe + la web si navega + los
// patrones aws de lectura (`Bash(aws <servicio> <operación>*)`, servicio + operación) + mcp__<server>__<tool>.
// deny, como defensa en profundidad sobre el allowlist (dontAsk ya niega lo no listado): NotebookEdit siempre, la
// web si no navega, Edit/Write enteras si ni escribe ni amplía su memoria, Bash entero sin shell, los comandos aws
// de secretos y de fichero local con la shell de solo lectura, las lecturas de credenciales en todo kit sin shell
// entera y, sin vcsPush, push y remotos. el orden de los ids es el del server: el render se compara con sus listas.
// decisiones:
// - invariantes del daemon, no del cable: las lecturas de credenciales negadas en todo kit sin Bash entero (con
//   Bash entero no acotarían nada) y el permission mode (dontAsk sin autonomía; con ella, el de su nivel).
// - la aws en lectura sale de shell read + un grant de aws + la aws cli de esta máquina (lo que el server deduce de
//   la capability `aws`). sin grant no hay patrones: la identidad aws por defecto no se concede implícita.
// - la lista de comandos aws negados en lectura es la del server (AGENT_AWS_READ_DENIED_COMMANDS: secretos,
//   parámetros, credenciales), no la de escritores de fichero del claim legacy (claim.ts::AWS_OUTFILE_COMMANDS),
//   que el parse del claim sigue añadiendo a todo kit de lectura.
// - autonomía (t#527, `autonomy` del toolset): el nivel decide qué va al allow, igual que el server; lo demás lo
//   pregunta la tool de permisos (manual), lo decide el clasificador del cli (auto) o pasa sin preguntar (bypass). el
//   allow = leer + Bash entero solo en bypass con shell full + Edit/Write y la web fuera de manual + la aws en lectura
//   como siempre + las tools de la plataforma + `approvals` al final, sin repetir. el deny es el mismo que sin
//   autonomía (en bypass sigue mandando) y el permission mode, el del nivel (AGENT_AUTONOMY_PERMISSION_MODE).

import {
  AGENT_AUTONOMY,
  AGENT_AUTONOMY_PERMISSION_MODE,
  AGENT_AWS_READ_COMMANDS,
  AGENT_AWS_READ_DENIED_COMMANDS,
  AGENT_AWS_READ_SERVICES,
  AGENT_AWS_READ_VERBS,
  GRANT_TYPE,
  TOOLSET_SHELL,
  type ToolsetV1,
} from '../vendor/runner-protocol/index.js';
import { BASH_TOOL, PROMPT_PERMISSION_MODE } from '../claim.js';

// ids de las built-in del cli de claude por capacidad del toolset (CLAUDE_CODE_TOOLS del server).
export const CLAUDE_CODE_TOOLS = {
  fsRead: ['Read', 'Grep', 'Glob'],
  shell: BASH_TOOL,
  fsWrite: ['Edit', 'Write'],
  web: ['WebFetch', 'WebSearch'],
  notebook: 'NotebookEdit',
} as const;

// lecturas de credenciales locales, genéricas y relativas a ~ (AGENT_SECRET_READ_DENY del server). las rutas reales
// de esta máquina las añade aparte secret-paths.ts al argv.
export const SECRET_READ_DENY: readonly string[] = [
  'Read(~/.aws/**)',
  'Read(~/.ssh/**)',
  'Read(~/.duckhunt-runner.json)',
  'Read(~/.claude/.credentials.json)',
  'Read(~/.config/gh/**)',
  'Read(~/.netrc)',
  'Read(~/.git-credentials)',
  'Read(~/.docker/config.json)',
  'Read(//tmp/duckhunt-runner-*)',
];

// sin vcsPush: ni push ni remotos (AGENT_UNATTENDED_EDIT_DENY del server; de mejor esfuerzo con Bash entero).
export const VCS_PUSH_DENY: readonly string[] = [`${BASH_TOOL}(git push*)`, `${BASH_TOOL}(git remote*)`, `${BASH_TOOL}(gh *)`];

const MCP_PREFIX = 'mcp__';
const MCP_SEPARATOR = '__';

// patrón de la aws cli fijado en servicio + operación (el `*` solo alarga argumentos).
const awsBash = (command: string): string => `${BASH_TOOL}(aws ${command}*)`;
/** los patrones de la aws en lectura, en el orden del server. */
export const AWS_READ_ALLOWED: readonly string[] = [
  ...AGENT_AWS_READ_SERVICES.flatMap((service) => AGENT_AWS_READ_VERBS.map((verb) => `${service} ${verb}`)),
  ...AGENT_AWS_READ_COMMANDS,
].map(awsBash);
const AWS_READ_DENIED: readonly string[] = AGENT_AWS_READ_DENIED_COMMANDS.map(awsBash);

/** las listas de tools de claude code y su permission mode. */
export interface ClaudeTools {
  allowed: string[];
  disallowed: string[];
  permissionMode: string;
}

/** lo que el render necesita de la máquina y del claim. */
export interface RenderContext {
  // server mcp de la plataforma (mcp.serverName del claim): prefijo de sus tools.
  mcpServerName: string;
  // aws cli instalada (la capability `aws` que anuncia el daemon).
  awsCli: boolean;
}

/** ¿lleva el render los patrones de la aws en lectura? (ver cabecera). */
export const rendersAwsRead = (t: ToolsetV1, ctx: RenderContext): boolean =>
  t.shell === TOOLSET_SHELL.read && ctx.awsCli && t.grants.some((g) => g.type === GRANT_TYPE.aws);

/** toolset_v1 → listas de claude code (ver cabecera). */
export function renderClaudeTools(t: ToolsetV1, ctx: RenderContext): ClaudeTools {
  // sin autonomía, el kit fijo: todo lo que concede el toolset va al allow.
  const level = t.autonomy;
  const asked = level === AGENT_AUTONOMY.manual;
  const allowed = [
    ...CLAUDE_CODE_TOOLS.fsRead,
    ...(t.shell === TOOLSET_SHELL.full && (level === undefined || level === AGENT_AUTONOMY.bypass) ? [CLAUDE_CODE_TOOLS.shell] : []),
    ...(t.fsWrite && !asked ? CLAUDE_CODE_TOOLS.fsWrite : []),
    ...(t.web && !asked ? CLAUDE_CODE_TOOLS.web : []),
    ...(rendersAwsRead(t, ctx) ? AWS_READ_ALLOWED : []),
    ...t.platformTools.map((tool) => `${MCP_PREFIX}${ctx.mcpServerName}${MCP_SEPARATOR}${tool}`),
  ];
  return {
    allowed: t.approvals ? Array.from(new Set([...allowed, ...t.approvals])) : allowed,
    disallowed: [
      CLAUDE_CODE_TOOLS.notebook,
      ...(t.web ? [] : CLAUDE_CODE_TOOLS.web),
      ...(t.memory || t.fsWrite ? [] : CLAUDE_CODE_TOOLS.fsWrite),
      ...(t.shell === TOOLSET_SHELL.none ? [CLAUDE_CODE_TOOLS.shell] : []),
      ...(t.shell === TOOLSET_SHELL.read ? AWS_READ_DENIED : []),
      ...(t.shell === TOOLSET_SHELL.full ? [] : SECRET_READ_DENY),
      ...(t.vcsPush ? [] : VCS_PUSH_DENY),
    ],
    permissionMode: level === undefined ? PROMPT_PERMISSION_MODE : AGENT_AUTONOMY_PERMISSION_MODE[level],
  };
}
