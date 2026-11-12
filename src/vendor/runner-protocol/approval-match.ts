// reglas «siempre aquí» de una conversación con autonomía (t#527): la regla del cli de claude que se le ofrece a la
// persona al pedir un permiso y si una regla ya aprobada cubre una petición nueva. puro, sin db. vive en el protocolo
// (t#440 P2) porque la misma coincidencia la aplicará el puente de aprobaciones de otro backend en el daemon («siempre
// aquí» se casa solo en el puente con approvalCovers); el chequeo de secretos (maskSecrets) se queda en el server
// (services/agent-harness/permissions.ts).
// decisiones:
// - la regla es un id de --allowedTools del cli (`Edit`, `Bash(pnpm test)`, `Bash(pnpm test:*)`, `WebFetch(domain:x)`,
//   `mcp__s__t`): desde el siguiente segmento la aplica el propio cli con su matcher. en el segmento que corre (el
//   proceso ya arrancó con su allow) la plataforma responde sola a lo que cubre `approvalCovers`, que es más estrecho
//   que el del cli a propósito: un comando con operadores de shell nunca casa (el cli parte `a && b`; aquí se vuelve a
//   preguntar) y una entrada recortada tampoco (lo que no se ve puede no casar: permissions.ts no la mira).
// - la shell (revisión de seguridad): la regla es el comando EXACTO (`Bash(<comando>)`), salvo que lleve un separador
//   `--` (lo que sigue suele ser argumentos de un runner de tests): entonces el prefijo hasta él con comodín
//   (`Bash(<prefijo>:*)`), de al menos dos palabras, sin acabar en una opción (`-c`, `-e`…) y nunca si alguna de sus
//   palabras (por su nombre base) es una shell, un intérprete o un lanzador (bash, node, python, env, sudo, xargs,
//   npx, dlx…: su prefijo dejaría pasar cualquier cosa). un comando con operadores, comillas, variables, escapes o
//   comodines del cli (`*`, que en una regla «exacta» el cli leería como comodín) no ofrece regla: solo esa vez.
//   approvalCovers vuelve a comprobar la forma de la regla (una que no saldría de aquí no cubre nada) y que lo que va
//   tras el prefijo no lleve comillas, variables ni escapes.
// - las escrituras (Edit, Write, MultiEdit) y el resto de tools: la tool entera. la web: su dominio.

/** largo de una regla «siempre aquí» (el de un id de tool que el daemon acepta). */
export const AGENT_PERMISSION_APPROVAL_MAX_CHARS = 200;

const BASH_TOOL = 'Bash';
const WEB_FETCH_TOOL = 'WebFetch';
// el separador de opciones: lo que va detrás no entra en el prefijo.
const OPTIONS_END = '--';
// palabras mínimas de un prefijo con comodín.
const BASH_PREFIX_MIN_TOKENS = 2;
// operadores que encadenan, redirigen o sustituyen: un comando con alguno no ofrece regla ni casa con una.
const SHELL_OPERATOR_RE = /[;&|<>`\n\r]|\$\(/;
// lo que no cabe en una regla exacta (comillas, variables, escapes) ni en un id de --allowedTools (paréntesis, comas).
const EXACT_UNSAFE_RE = /['"$\\(),*?[\]{}]/;
const RULE_UNSAFE_RE = /[(),\n\r]/;
const OPTION_RE = /^-/;
// shells, intérpretes y envoltorios: su prefijo ejecuta cualquier cosa que venga detrás.
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'env', 'eval', 'exec', 'source', 'command', 'builtin',
  'sudo', 'su', 'doas', 'nohup', 'timeout', 'nice', 'time', 'watch', 'xargs', 'parallel', 'ssh',
  'node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'lua', 'awk', 'gawk', 'osascript',
  'tsx', 'ts-node', 'npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'dlx', 'exec',
]);
// el nombre base de una palabra (`/usr/bin/env` → `env`).
const baseName = (token: string): string => token.slice(token.lastIndexOf('/') + 1);
// ¿vale este prefijo para una regla con comodín? (ver cabecera)
const prefixAllowed = (tokens: readonly string[]): boolean =>
  tokens.length >= BASH_PREFIX_MIN_TOKENS && !tokens.some((t) => WRAPPER_COMMANDS.has(baseName(t))) && !OPTION_RE.test(tokens.at(-1)!);
// forma de las reglas con argumento que se generan aquí.
const BASH_PREFIX_RULE_RE = /^Bash\((.+):\*\)$/;
const BASH_EXACT_RULE_RE = /^Bash\((.+)\)$/;
const DOMAIN_RULE_RE = /^WebFetch\(domain:([^)]+)\)$/;
// id de una tool del cli (lo que va entero en el allow).
const TOOL_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

const commandOf = (input: Record<string, unknown>): string | null => (typeof input.command === 'string' ? input.command.trim() : null);

function hostOf(input: Record<string, unknown>): string | null {
  if (typeof input.url !== 'string') return null;
  try {
    return new URL(input.url).hostname || null;
  } catch {
    // una url que no se puede leer no ofrece regla: se aprueba solo esa vez.
    return null;
  }
}

// la regla de un comando de shell (ver cabecera): el prefijo hasta `--` con comodín, o el comando exacto.
function bashRule(command: string): string | null {
  if (command === '' || SHELL_OPERATOR_RE.test(command) || EXACT_UNSAFE_RE.test(command)) return null;
  const tokens = command.split(/\s+/);
  const cut = tokens.indexOf(OPTIONS_END);
  const prefix = cut < 0 ? [] : tokens.slice(0, cut);
  return prefixAllowed(prefix) ? `${BASH_TOOL}(${prefix.join(' ')}:*)` : `${BASH_TOOL}(${tokens.join(' ')})`;
}

function ruleFor(toolName: string, input: Record<string, unknown>, truncated: boolean): string | null {
  // recortada, lo que se ve puede no ser lo que corre.
  if (truncated) return null;
  if (toolName === BASH_TOOL) {
    const command = commandOf(input);
    return command === null ? null : bashRule(command);
  }
  if (toolName === WEB_FETCH_TOOL) {
    const host = hostOf(input);
    return host === null || RULE_UNSAFE_RE.test(host) ? null : `${WEB_FETCH_TOOL}(domain:${host})`;
  }
  return TOOL_ID_RE.test(toolName) ? toolName : null;
}

/** la regla «siempre aquí» que se ofrece para una petición (null = no se ofrece: solo «permitir» esta vez). */
export function suggestApproval(toolName: string, input: Record<string, unknown>, truncated: boolean): string | null {
  const rule = ruleFor(toolName, input, truncated);
  // una regla más larga que un id de tool que el daemon acepta no se ofrece.
  return rule !== null && rule.length <= AGENT_PERMISSION_APPROVAL_MAX_CHARS ? rule : null;
}

/** ¿la regla aprobada cubre esta petición? (más estrecho que el matcher del cli: ver cabecera; la entrada, sin recortar). */
export function approvalCovers(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  if (rule === toolName) return toolName !== BASH_TOOL;
  const command = toolName === BASH_TOOL ? commandOf(input) : null;
  const simple = command !== null && !SHELL_OPERATOR_RE.test(command);
  const prefix = BASH_PREFIX_RULE_RE.exec(rule);
  if (prefix) {
    const body = prefix[1]!;
    const shaped = !EXACT_UNSAFE_RE.test(body) && prefixAllowed(body.split(' '));
    const rest = simple && command.startsWith(`${body} `) ? command.slice(body.length + 1) : null;
    return shaped && simple && (command === body || (rest !== null && !EXACT_UNSAFE_RE.test(rest)));
  }
  const exact = BASH_EXACT_RULE_RE.exec(rule);
  if (exact) return simple && !EXACT_UNSAFE_RE.test(exact[1]!) && command === exact[1];
  const domain = DOMAIN_RULE_RE.exec(rule);
  return domain !== null && toolName === WEB_FETCH_TOOL && hostOf(input) === domain[1];
}
