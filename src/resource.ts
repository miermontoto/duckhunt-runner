// subcomandos `duckhunt-runner resource ...` (t#495, M2): los recursos de esta máquina por tipo. cada tipo conserva
// su cli de siempre, que es la que hace el trabajo: `resource add repo …` es `repos add …` y `resource remove aws …`
// es `aws remove …`, con la misma salida y el mismo exit code (aws acepta además la clave `default`, la identidad
// aws por defecto, que solo existe si el usuario la expone). `list` sin tipo los lista todos; `check` mide la salud
// de lo mapeado (hoy solo la de los repos) y sale con 1 si algo bloquea un run.
// (t#495, M7) browser es otro tipo: su cli es `browser` (browser-cli.ts), con `add` como `login`, y su check prueba
// cada sesión con odysea.

import { loadConfigV2, loadStoredConfig } from './config.js';
import { awsCommand, RESOURCE_AWS_KEYS } from './aws.js';
import { reposCommand } from './repos.js';
import { BROWSER_SUB, browserCommand } from './browser-cli.js';
import { BLOCKING_REPO_ISSUES, describeFinding, repoFindings, scanRepos } from './resources/repo/health.js';
import { RESOURCE_TYPE } from './resources/types.js';
import { scrubEnv } from './scrub-env.js';

const USAGE = `uso:
  duckhunt-runner resource list [repo|aws]
  duckhunt-runner resource add repo <workspace/slug> <path>
  duckhunt-runner resource add aws <account-id|default> <profile> [region]
  duckhunt-runner resource remove repo|aws <clave>
  duckhunt-runner resource check [repo|browser]
  duckhunt-runner resource add browser <clave> <url> [--origin <patrón> …] (es \`browser login\`)
  duckhunt-runner resource remove browser <clave> [--purge]
  (\`repos\` y \`aws\` son los mismos comandos: \`resource discover repo\` es \`repos discover\`)
`;

const SUB = { list: 'list', check: 'check' } as const;

type TypeCommand = (args: string[]) => Promise<void> | void;
const COMMANDS: Readonly<Record<string, TypeCommand>> = {
  [RESOURCE_TYPE.repo]: reposCommand,
  [RESOURCE_TYPE.aws]: (args) => awsCommand(args, RESOURCE_AWS_KEYS),
  [RESOURCE_TYPE.browser]: browserCommand,
};

const noConfig = (): void => {
  console.error('sin config: ejecuta `duckhunt-runner login <base-url>` primero');
  process.exitCode = 1;
};

// salud de los repos mapeados, con paths (local): la misma que `status` y `repos list`.
async function checkRepos(): Promise<void> {
  const cfg = loadStoredConfig();
  if (!cfg) return noConfig();
  const findings = repoFindings(await scanRepos(cfg.repos, scrubEnv(process.env)));
  if (findings.length === 0) console.log(`${RESOURCE_TYPE.repo}: sin avisos`);
  findings.forEach((f) => console.log(`  ⚠ ${describeFinding(f)}`));
  if (findings.some((f) => BLOCKING_REPO_ISSUES.has(f.issue.kind))) process.exitCode = 1;
}

// tipos con chequeo de salud.
const CHECKS: Readonly<Record<string, () => Promise<void>>> = {
  [RESOURCE_TYPE.repo]: checkRepos,
  [RESOURCE_TYPE.browser]: () => browserCommand([BROWSER_SUB.check]),
};

// tipos que `list` y `check` sin tipo recorren aunque no tengan nada: los de siempre. browser solo si hay sesiones
// (sin ellas la salida es la de antes del navegador).
const ALWAYS_LISTED: ReadonlySet<string> = new Set([RESOURCE_TYPE.repo, RESOURCE_TYPE.aws]);

function hasEntries(type: string): boolean {
  try {
    return Object.keys(loadConfigV2()?.resources[type] ?? {}).length > 0;
  } catch {
    return false;
  }
}

const shown = (type: string): boolean => ALWAYS_LISTED.has(type) || hasEntries(type);

const usage = (): void => {
  console.error(USAGE);
  process.exitCode = 1;
};

export async function resourceCommand(args: string[]): Promise<void> {
  const [sub, type, ...rest] = args;
  if (sub === SUB.list && type === undefined) {
    // i/o secuencial: la lista de cada tipo, en orden.
    for (const [t, command] of Object.entries(COMMANDS).filter(([t]) => shown(t))) {
      console.log(`${t}:`);
      await command([SUB.list]);
    }
    return;
  }
  if (sub === SUB.check) {
    if (type !== undefined && !Object.hasOwn(CHECKS, type)) return usage();
    // i/o secuencial: un chequeo tras otro.
    for (const check of type === undefined ? Object.entries(CHECKS).filter(([t]) => shown(t)).map(([, c]) => c) : [CHECKS[type]!]) await check();
    return;
  }
  const command = sub !== undefined && type !== undefined && Object.hasOwn(COMMANDS, type) ? COMMANDS[type] : undefined;
  if (!command) return usage();
  await command([sub!, ...rest]);
}
