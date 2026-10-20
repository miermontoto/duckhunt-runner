// subcomandos `duckhunt-runner browser ...` (t#495, M7): las sesiones de navegador de esta máquina, guardadas por
// odysea en el vault (resources/browser). `login` abre el navegador visible de odysea para que la persona inicie
// sesión y guarda la entrada `resources.browser.<clave>` con su allowlist de orígenes; `list` las enseña con su
// salud (solo json), `check` además las prueba con `odysea probe` y sale con 1 si alguna no sirve, y `remove` quita la
// entrada (el fichero del vault solo con --purge y si ninguna otra clave lo usa). también son `resource … browser`.
// ninguna plataforma ve una sesión hasta que se le expone (`platforms expose <id> browser <clave>`).

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfigV2, saveConfigV2, type RunnerConfigV2 } from './config.js';
import { ensureBrowserVault } from './paths.js';
import { BROWSER_KEY_RE, BROWSER_SESSION_RE, originPatterns, vaultDirOf, vaultFileOf, type BrowserRef } from './resources/browser/config.js';
import { BLOCKING_BROWSER_HEALTH, browserHealth, PROBE_MODE, type BrowserFinding, type ProbeMode } from './resources/browser/health.js';
import { detectOdysea, ODYSEA_LOGIN_EXIT, odyseaLogin } from './resources/browser/odysea-cli.js';
import { originOf } from './resources/browser/origins.js';
import { RESOURCE_TYPE } from './resources/types.js';

const USAGE = `uso:
  duckhunt-runner browser login <clave> <url> [--origin <patrón> …] [--session <nombre>] [--exclusive]
                                [--probe-url <url> [--login-pattern <regex>]]
  duckhunt-runner browser list
  duckhunt-runner browser check [clave]
  duckhunt-runner browser remove <clave> [--purge]
  (también \`resource add|list|check|remove browser …\`; ninguna plataforma la ve hasta \`platforms expose <id> browser <clave>\`)
`;

export const BROWSER_SUB = { login: 'login', add: 'add', list: 'list', check: 'check', remove: 'remove' } as const;

const LOGIN_OPTIONS = {
  origin: { type: 'string', multiple: true },
  session: { type: 'string' },
  exclusive: { type: 'boolean' },
  'probe-url': { type: 'string' },
  'login-pattern': { type: 'string' },
} as const;
const REMOVE_OPTIONS = { purge: { type: 'boolean' } } as const;

const fail = (msg: string): void => {
  console.error(msg);
  process.exitCode = 1;
};

const usage = (): void => fail(USAGE);

const entriesOf = (cfg: RunnerConfigV2 | null): Readonly<Record<string, BrowserRef>> =>
  (cfg?.resources[RESOURCE_TYPE.browser] ?? {}) as Readonly<Record<string, BrowserRef>>;

// la config v2 del fichero; null si no se puede leer (ya avisado).
function readConfig(): { cfg: RunnerConfigV2 | null } | null {
  try {
    return { cfg: loadConfigV2() };
  } catch (err) {
    fail((err as Error).message);
    return null;
  }
}

const describe = (key: string, ref: BrowserRef): string =>
  `${key} → sesión ${ref.session} · ${ref.origins.join(', ')}${ref.exclusive ? ' · exclusiva' : ''}${ref.probe ? ` · probe ${ref.probe.url}` : ''}`;

// la salud de unas sesiones, impresa; devuelve si alguna bloquea.
async function printHealth(cfg: RunnerConfigV2 | null, entries: Readonly<Record<string, BrowserRef>>, probe: ProbeMode): Promise<boolean> {
  const odysea = await detectOdysea(cfg?.providers?.browser?.bin);
  const findings = await browserHealth({ entries, vaultDir: vaultDirOf(cfg?.providers), odysea, probe, lastProbe: new Map(), nowMs: Date.now() });
  const byKey = findings.reduce((acc, f) => acc.set(f.key, [...(acc.get(f.key) ?? []), f]), new Map<string, BrowserFinding[]>());
  Object.entries(entries).forEach(([key, ref]) => {
    console.log(`  ${describe(key, ref)}`);
    (byKey.get(key) ?? []).forEach((f) => console.log(`    ⚠ ${f.kind}: ${f.detail}`));
  });
  return findings.some((f) => BLOCKING_BROWSER_HEALTH.has(f.kind));
}

async function login(args: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs<{ args: string[]; options: typeof LOGIN_OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options: LOGIN_OPTIONS, allowPositionals: true });
  } catch (err) {
    return fail(`${(err as Error).message}\n${USAGE}`);
  }
  const [key, url] = parsed.positionals;
  const { values } = parsed;
  if (!key || !url || parsed.positionals.length !== 2) return usage();
  if (!BROWSER_KEY_RE.test(key)) return fail(`clave no válida: "${key}" (${BROWSER_KEY_RE.source})`);
  const origin = originOf(url);
  if (origin === null) return fail(`url no válida: "${url}" (http o https)`);
  if (values['login-pattern'] !== undefined && values['probe-url'] === undefined) return fail('--login-pattern necesita --probe-url');
  const read = readConfig();
  if (!read) return;
  const existing = entriesOf(read.cfg)[key];
  const session = values.session ?? existing?.session ?? key;
  if (!BROWSER_SESSION_RE.test(session)) return fail(`sesión no válida: "${session}" (${BROWSER_SESSION_RE.source})`);
  const probeUrl = values['probe-url'];
  if (probeUrl !== undefined && originOf(probeUrl) === null) return fail(`--probe-url no válida: "${probeUrl}"`);
  const ref: BrowserRef = {
    session,
    // sin --origin: los de antes o, en una nueva, el de la url de login.
    origins: values.origin ?? existing?.origins ?? [origin],
    ...(values.exclusive || existing?.exclusive ? { exclusive: true } : {}),
    ...(probeUrl !== undefined
      ? { probe: { url: probeUrl, ...(values['login-pattern'] !== undefined ? { loginPattern: values['login-pattern'] } : {}) } }
      : existing?.probe
        ? { probe: existing.probe }
        : {}),
  };
  try {
    originPatterns(ref);
    if (ref.probe?.loginPattern !== undefined) new RegExp(ref.probe.loginPattern);
  } catch (err) {
    return fail((err as Error).message);
  }
  const odysea = await detectOdysea(read.cfg?.providers?.browser?.bin);
  if (!odysea.ok) return fail(`sin odysea: ${odysea.reason}`);
  const vaultDir = ensureBrowserVault(vaultDirOf(read.cfg?.providers));
  const stateFile = vaultFileOf(vaultDir, session);
  const code = await odyseaLogin(odysea.info.bin, stateFile, url);
  // cerrar la ventana antes de enter deja el último autosave: vale si llegó a guardarse algo.
  const saved = code === ODYSEA_LOGIN_EXIT.ok || (code === ODYSEA_LOGIN_EXIT.aborted && fs.existsSync(stateFile));
  if (!saved) return fail(`el login de odysea no guardó la sesión (exit ${code ?? 'sin código'}): ${key} no se ha guardado`);
  saveConfigV2((cfg) => ({ ...cfg, resources: { ...cfg.resources, [RESOURCE_TYPE.browser]: { ...entriesOf(cfg), [key]: ref } } }));
  console.log(`${existing ? 'actualizada' : 'añadida'} la sesión de navegador:`);
  const blocked = await printHealth(loadConfigV2(), { [key]: ref }, ref.probe ? PROBE_MODE.force : PROBE_MODE.never);
  if (blocked) process.exitCode = 1;
  if (!existing) console.log(`ninguna plataforma la ve aún: \`duckhunt-runner platforms expose <id> ${RESOURCE_TYPE.browser} ${key}\``);
}

async function list(): Promise<void> {
  const read = readConfig();
  if (!read) return;
  const entries = entriesOf(read.cfg);
  if (Object.keys(entries).length === 0) {
    console.log(`sin sesiones de navegador (\`duckhunt-runner browser login <clave> <url>\`)`);
    return;
  }
  await printHealth(read.cfg, entries, PROBE_MODE.never);
}

async function check(args: string[]): Promise<void> {
  const [key, ...extra] = args;
  if (extra.length > 0) return usage();
  const read = readConfig();
  if (!read) return;
  const all = entriesOf(read.cfg);
  if (key !== undefined && !Object.hasOwn(all, key)) return fail(`no hay sesión de navegador ${key}`);
  const entries = key === undefined ? all : { [key]: all[key]! };
  if (Object.keys(entries).length === 0) {
    console.log(`${RESOURCE_TYPE.browser}: sin sesiones`);
    return;
  }
  if (await printHealth(read.cfg, entries, PROBE_MODE.force)) process.exitCode = 1;
}

function remove(args: string[]): void {
  let parsed: ReturnType<typeof parseArgs<{ args: string[]; options: typeof REMOVE_OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options: REMOVE_OPTIONS, allowPositionals: true });
  } catch (err) {
    return fail(`${(err as Error).message}\n${USAGE}`);
  }
  const [key] = parsed.positionals;
  if (!key || parsed.positionals.length !== 1) return usage();
  const read = readConfig();
  if (!read) return;
  const ref = entriesOf(read.cfg)[key];
  if (!ref) return fail(`no hay sesión de navegador ${key}`);
  saveConfigV2((cfg) => {
    const { [key]: _, ...rest } = entriesOf(cfg);
    return { ...cfg, resources: { ...cfg.resources, [RESOURCE_TYPE.browser]: rest } };
  });
  console.log(`quitada la sesión de navegador ${key}`);
  if (!parsed.values.purge) return;
  const shared = Object.entries(entriesOf(read.cfg)).some(([other, r]) => other !== key && r.session === ref.session);
  if (shared) {
    console.log(`el fichero de la sesión ${ref.session} se queda: otra clave lo usa`);
    return;
  }
  fs.rmSync(vaultFileOf(vaultDirOf(read.cfg?.providers), ref.session), { force: true });
  console.log(`borrado el fichero de la sesión ${ref.session} del vault`);
}

export async function browserCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === BROWSER_SUB.login || sub === BROWSER_SUB.add) return login(rest);
  if (sub === BROWSER_SUB.list && rest.length === 0) return list();
  if (sub === BROWSER_SUB.check) return check(rest);
  if (sub === BROWSER_SUB.remove) return remove(rest);
  usage();
}
