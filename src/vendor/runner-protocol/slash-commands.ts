// catálogo de slash commands de una máquina (t#555): lo que el modelo de un run puede invocar con la tool Skill del cli,
// con su descripción, para el autocompletado `/` del composer de /agents. el daemon lo sube a
// POST /api/runner/slash-commands solo cuando cambia (y al arrancar, desde su caché): no viaja en el claim, que va cada
// pocos segundos y no necesita ~20 KB de nombres.
// decisiones:
// - la verdad son los nombres del `system/init` de los runs reales (`slash_commands` + `skills`); el daemon no imita el
//   descubrimiento del cli. se quedan las skills y los comandos con fichero: los built-ins (clear, compact, model…)
//   salen en `slash_commands` sin fichero y Skill no los ejecuta.
// - descripción y argument-hint salen del frontmatter del fichero que el daemon localiza (comandos y skills del
//   usuario, de los plugins del init y del proyecto del cwd); sin fichero o sin frontmatter, null.
// - dos ámbitos: `user` (usuario, plugins y skills empaquetadas: los carga todo run, también uno de lectura con
//   `--setting-sources user`) y por repo los del proyecto, que solo carga un run en edición. el server decide qué lista
//   va a cada composer; la web solo filtra lo que llega.
// - son datos de presencia: lo que pasa de los topes se recorta y lo que no tiene forma se descarta. la descripción de un
//   comando del proyecto la escribe cualquiera con push al repo: es texto, nunca instrucciones.
// non-goals: ejecutar el comando de forma determinista (el cli solo lo expande al principio del prompt y el contrato de
// duckhunt va delante; con --resume no se puede mover a --append-system-prompt) y los built-ins.

/** ruta del catálogo bajo /api/runner (cable legacy). */
export const RUNNER_SLASH_COMMANDS_PATH = '/slash-commands';

/** de dónde sale un comando: el usuario, un plugin, una skill empaquetada del cli o el proyecto del repo. */
export const SLASH_COMMAND_SCOPE = {
  user: 'user',
  plugin: 'plugin',
  bundled: 'bundled',
  project: 'project',
} as const;
export type SlashCommandScope = (typeof SLASH_COMMAND_SCOPE)[keyof typeof SLASH_COMMAND_SCOPE];

/** nombre invocable tal cual lo da el init: `bugfix`, `code-review:code-review` (plugin:comando). */
export const SLASH_COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
// comandos por lista (la del usuario o la de un repo) y repos con comandos propios.
export const SLASH_COMMANDS_MAX = 400;
export const SLASH_COMMAND_REPOS_MAX = 200;
export const SLASH_COMMAND_REPO_MAX_CHARS = 200;
// textos del frontmatter, recortados por el daemon (el server descarta lo que se pase).
export const SLASH_COMMAND_DESCRIPTION_MAX_CHARS = 240;
export const SLASH_COMMAND_ARGUMENT_HINT_MAX_CHARS = 80;

/** un comando invocable con su ayuda. */
export interface SlashCommand {
  name: string;
  description: string | null;
  argumentHint: string | null;
  scope: SlashCommandScope;
}

/** cuerpo de POST /api/runner/slash-commands: el catálogo ENTERO de la máquina (reemplaza al guardado). */
export interface RunnerSlashCommands {
  user: SlashCommand[];
  // repo en la grafía del mapa de la máquina (ws/slug) → sus comandos de proyecto.
  repos: { repo: string; commands: SlashCommand[] }[];
}
