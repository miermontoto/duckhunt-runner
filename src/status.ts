// `duckhunt-runner status`: si hay un daemon en marcha (daemon-lock.ts), qué kit tiene esta máquina
// (claude, credencial detectada, aws cli, las capacidades que anunciaría el daemon) y qué hay mapeado
// (repos con sus avisos de salud, cuentas aws). diagnóstico local, sin tocar el server: lo que duckhunt
// dice de esta máquina (nombre, pausa, qué acepta, tope de slots, por qué no recibe trabajo y los
// worktrees que el gc conservó) es lo del último claim del daemon (server-state.ts), con su edad (t#465
// P12). también avisa de los flags de repo deprecados (worktree: false, dangerouslySkipPermissions) que
// ya no aplica nada.
// `status --platforms` (t#495, M6.6): cada plataforma de la config con su protocolo, credencial, estado local, lo
// último que dijo su server, su cuota (slots y la del día, de su auditoría), su techo, lo que ve de la máquina con
// su salud y el resumen de su auditoría de las últimas 24 h. tampoco toca ningún server; `status` sin el flag sigue
// siendo, byte a byte, el de siempre.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { concurrency, configPath, deprecatedRepoFlags, loadConfigV2, loadStoredConfig, REPO_FLAGS_DEPRECATED, type StoredConfig } from './config.js';
import { AUDIT_EVENT, DAY_MS, dayUsage, readAudit } from './audit.js';
import { PLATFORM_FACTORIES } from './platforms/factories.js';
import { PROTOCOL } from './platforms/platform.js';
import { EXPOSE_ALL, PLATFORM_DEFAULT_SLOTS, type PlatformConfig } from './platforms/types.js';
import { LEGACY_RESOURCE_KEYS } from './config-legacy.js';
import type { RepoFinding } from './resources/repo/health.js';
import { RESOURCE_TYPE } from './resources/types.js';
import { LEGACY_PLATFORM_ID, scratchDir } from './paths.js';
import { daemonLockHolder } from './daemon-lock.js';
import { detectClaude } from './claude.js';
import { announcedCapabilities } from './announced-capabilities.js';
import { describeFinding, repoFindings, scanRepos } from './resources/repo/health.js';
import { scrubEnv } from './scrub-env.js';
import { ownedHere } from './machine.js';
import { CLAIM_OUTCOME, readServerState, type ServerState } from './server-state.js';
import { runnerVersion } from './version.js';

// motivo legible del estado que dijo el server.
const STATE_TEXT: Readonly<Record<string, string>> = {
  [CLAIM_OUTCOME.claimed]: 'reclamó un run',
  [CLAIM_OUTCOME.unpaired]: 'credencial rechazada: desvinculada desde duckhunt, revocada o caducada (`duckhunt-runner login`)',
  paused: 'en pausa (la tuya o la de esta máquina, desde duckhunt)',
  full: 'sin slot libre',
  upgrade_required: 'no recibe trabajo: actualiza duckhunt-runner o claude code',
};

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};

/** líneas de lo que duckhunt dijo de esta máquina en el último claim (para `status`). */
export function describeServerState(state: ServerState | null, clientId: string | undefined, now = Date.now()): string[] {
  if (!state) return ['en duckhunt: sin datos (el daemon aún no ha reclamado con esta credencial)'];
  const stale = clientId !== undefined && state.clientId !== clientId ? ' — de una credencial anterior: arranca el daemon para refrescarlo' : '';
  const r = state.runner;
  const lines = [
    `en duckhunt: hace ${ago(now - state.at)}${stale}`,
    r
      ? `  máquina #${r.id}${r.name ? ` «${r.name}»` : ''} · pausa ${r.paused ? 'sí' : 'no'} · acepta ${r.accepts} · tope de slots ${r.maxSlots ?? 'el anunciado'}`
      : '  sin los ajustes de la máquina (duckhunt anterior a 0.11)',
    `  estado: ${state.state === null ? 'recibe trabajo (nada en cola)' : (STATE_TEXT[state.state] ?? state.state)}`,
  ];
  const kept = state.kept ?? [];
  return [
    ...lines,
    ...(kept.length === 0
      ? []
      : [`  worktrees conservados: ${kept.length}`, ...kept.map((k) => `    r#${k.runId}: ${k.dirtyFiles} sin commitear, ${k.unpushedCommits} commit(s) sin subir`)]),
  ];
}

const execFileP = promisify(execFile);

// credencial que usará claude en esta máquina. ANTHROPIC_API_KEY en el env shadowea el login
// de suscripción (footgun documentado en el contrato 42): se avisa explícitamente.
async function credentialSummary(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return 'api key (ANTHROPIC_API_KEY en el env — shadowea el login de suscripción)';
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'oauth token (CLAUDE_CODE_OAUTH_TOKEN en el env)';
  try {
    const out = (await execFileP('claude', ['auth', 'status'], { encoding: 'utf-8' })).stdout.trim();
    // claude >= 2.1 responde json; antes era una línea de texto plano y nos quedábamos con ella.
    // quedarse con la primera línea del json imprimía un `{` pelado.
    if (out.startsWith('{')) {
      const j = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
      if (j.loggedIn === false) return 'SIN credencial detectada: ejecuta `claude` y haz login';
      const how = [j.authMethod, j.apiProvider].filter(Boolean).join(' · ');
      // el email que trae el json NO se imprime a propósito: este comando es lo que se pega en
      // un informe de problemas.
      return how ? `login de claude code (${how})` : 'login de claude code';
    }
    if (out) return out.split('\n')[0]!;
  } catch {
    // sin el subcomando (claude viejo) o con un json que no parsea: se infiere del fichero de
    // credenciales, que es el fallback de toda la vida.
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return fs.existsSync(path.join(configDir, '.credentials.json')) ? 'login de claude code (credenciales locales)' : 'SIN credencial detectada: ejecuta `claude` y haz login';
}

// flag de la vista por plataformas.
const PLATFORMS_FLAG = '--platforms';
// cómo empieza lo que describeServerState dice del server de duckhunt (en la vista por plataformas, el de cada una).
const SERVER_SAID_PREFIX = /^en duckhunt/;
const USD_DECIMALS = 2;

// el estado local de una plataforma visto desde fuera del daemon: la config, lo último que guardó de su server y
// su auditoría del día.
function localState(id: string, p: PlatformConfig, credentialId: string | undefined, now: number): string {
  const legacy = id === LEGACY_PLATFORM_ID;
  const protocol = p.protocol ?? (legacy ? PROTOCOL.duckhunt42 : undefined);
  if (protocol === undefined || !Object.hasOwn(PLATFORM_FACTORIES, protocol)) return `protocolo ${protocol ?? '(sin protocolo)'} sin soporte: no reclama`;
  if (!credentialId) return 'sin credencial (`login`): no reclama';
  if (!legacy && protocol === PROTOCOL.duckhunt42 && !p.trusted) return 'sin trusted (su techo no se aplica sin toolset_v1): no reclama';
  const said = readServerState(id);
  if (said?.state === CLAIM_OUTCOME.unpaired && said.clientId === credentialId) return 'desvinculada: credencial rechazada (`login`)';
  if (p.paused) return 'en pausa (la config): no reclama, sus runs siguen';
  const used = dayUsage(id, now);
  const over = (p.runsPerDay !== undefined && used.runs >= p.runsPerDay) || (p.budgetUsdPerDay !== undefined && used.costUsd >= p.budgetUsdPerDay);
  return over ? 'cuota del día agotada: no reclama hasta medianoche' : 'activa';
}

// lo que ve una plataforma de un tipo de recurso: todo (con cuántas claves hay) o su lista.
const exposedKeys = (p: PlatformConfig, type: string, mapped: readonly string[]): string[] => {
  const keys = Object.hasOwn(p.expose, type) ? p.expose[type] : undefined;
  return keys === undefined ? [] : keys === EXPOSE_ALL ? [...mapped] : mapped.filter((k) => keys.includes(k));
};

/** las líneas de `status --platforms` (ver cabecera). `findings`, la salud de los repos mapeados. */
export function platformsStatus(cfg: StoredConfig, findings: readonly RepoFinding[], now = Date.now()): string[] {
  const v2 = loadConfigV2();
  if (!v2) return ['plataformas: sin config'];
  const slots = concurrency(cfg.defaults);
  const day = readAudit(now - DAY_MS);
  return Object.entries(v2.platforms).flatMap(([id, p]) => {
    const legacy = id === LEGACY_PLATFORM_ID;
    const credentialId = legacy ? cfg.clientId : p.credential?.clientId;
    const baseUrl = legacy ? cfg.baseUrl : p.credential?.baseUrl;
    const quota = Math.min(p.slots ?? (legacy ? slots : PLATFORM_DEFAULT_SLOTS), slots);
    const used = dayUsage(id, now);
    const limits = [
      p.runsPerDay !== undefined ? `${used.runs}/${p.runsPerDay} segmentos` : `${used.runs} segmentos`,
      p.budgetUsdPerDay !== undefined ? `${used.costUsd.toFixed(USD_DECIMALS)}/${p.budgetUsdPerDay} usd` : `${used.costUsd.toFixed(USD_DECIMALS)} usd`,
    ];
    const c = p.ceiling;
    const yes = (b: boolean): string => (b ? 'sí' : 'no');
    const access = Object.entries(c.access).map(([type, a]) => `${type}:${a}`).join(' ') || 'ninguno';
    const exposed = Object.entries(LEGACY_RESOURCE_KEYS).map(([type, field]) => {
      const keys = exposedKeys(p, type, Object.keys(cfg[field]));
      return `${type} ${p.expose[type] === EXPOSE_ALL ? `* (${keys.length})` : keys.length === 0 ? 'nada' : keys.join(', ')}`;
    });
    const repos = exposedKeys(p, RESOURCE_TYPE.repo, Object.keys(cfg.repos));
    const health = findings.filter((f) => f.issue.repo !== null && repos.includes(f.issue.repo));
    const mine = day.filter((r) => r.platform === id);
    const failed = mine.filter((r) => r.event === AUDIT_EVENT.closed && r.outcome.status === 'failed').length;
    const rejected = mine.filter((r) => r.event === AUDIT_EVENT.rejected).length;
    const cost = mine.reduce((sum, r) => sum + (r.event === AUDIT_EVENT.closed ? (r.costUsd ?? 0) : 0), 0);
    // lo que dijo su server, con el nombre de la plataforma donde `status` dice duckhunt.
    const said = credentialId ? describeServerState(readServerState(id), credentialId, now).map((line) => `  ${legacy ? line : line.replace(SERVER_SAID_PREFIX, `en ${id}`)}`) : [];
    return [
      `${id}${p.name ? ` «${p.name}»` : ''} · ${p.protocol ?? PROTOCOL.duckhunt42} · ${baseUrl ?? '(sin login)'} · credencial ${credentialId ? 'sí' : 'no'}${p.trusted ? ' · trusted' : ''}`,
      `  estado: ${localState(id, p, credentialId, now)}`,
      ...said,
      `  cuota: ${quota} slot${quota === 1 ? '' : 's'} (de ${slots}) · hoy ${limits.join(' · ')}`,
      `  techo: shell ${c.shell} · escritura ${yes(c.fsWrite)} · memoria ${yes(c.memory)} · web ${yes(c.web)} · push ${yes(c.vcsPush)} · acceso ${access}`,
      `  expuesto: ${exposed.join(' · ')}`,
      ...(health.length === 0 ? [] : [`  avisos: ${health.length}`, ...health.map((f) => `    ⚠ ${describeFinding(f)}`)]),
      `  24 h: ${mine.filter((r) => r.event === AUDIT_EVENT.claimed).length} segmentos · ${failed} fallidos · ${rejected} rechazados · ${cost.toFixed(USD_DECIMALS)} usd`,
    ];
  });
}

export async function statusCommand(args: string[] = []): Promise<void> {
  if (args.includes(PLATFORMS_FLAG)) {
    const cfg = loadStoredConfig();
    if (!cfg) {
      console.log(`sin config (${configPath()}): ejecuta \`duckhunt-runner login <base-url>\``);
      return;
    }
    platformsStatus(cfg, repoFindings(await scanRepos(cfg.repos, scrubEnv(process.env)))).forEach((line) => console.log(line));
    return;
  }
  console.log(`daemon:     duckhunt-runner ${runnerVersion() ?? '?'} (config ${configPath()})`);
  const running = daemonLockHolder();
  console.log(`en marcha:  ${running ? `pid ${running.pid} desde ${running.startedAt} (config ${running.config})` : 'no'}`);
  const cfg = loadStoredConfig();
  if (!cfg) {
    console.log(`sin config (${configPath()}): ejecuta \`duckhunt-runner login <base-url>\``);
  } else {
    console.log(`servidor:   ${cfg.baseUrl ?? '(sin login)'}`);
    console.log(`runner:     ${cfg.label ?? os.hostname()} (${cfg.clientId ? `client ${cfg.clientId}` : 'sin credencial: `duckhunt-runner login`'})`);
    console.log(`máquina:    ${cfg.machineId ?? 'sin id (lo genera el daemon al arrancar)'}${cfg.machineId && !ownedHere(cfg) ? ` — generado en ${cfg.machineHost ?? 'otra máquina'}: haz \`login\` aquí para que sea otra máquina` : ''}`);
    if (cfg.clientId) describeServerState(readServerState(LEGACY_PLATFORM_ID), cfg.clientId).forEach((line) => console.log(line));
    console.log(`modelo:     el que pida duckhunt en cada run; si no pide ninguno, ${cfg.defaults.model ? `${cfg.defaults.model} (defaults.model)` : 'el default del cli'}`);
    console.log(`slots:      ${concurrency(cfg.defaults)} run(s) a la vez (defaults.maxConcurrent)`);
    console.log(`mapa:       ${cfg.defaults.remoteRepoEdits === false ? 'solo por la cli (defaults.remoteRepoEdits: false)' : 'también desde duckhunt (quitar repos, elegir carpeta)'}`);
  }
  const claude = await detectClaude();
  console.log(`claude:     ${claude.version ?? 'NO encontrado en el PATH'}`);
  if (claude.version) {
    console.log(`credencial: ${await credentialSummary()}`);
    console.log(`flags:      ${[...claude.supported].join(' ') || '(ninguno opcional)'}`);
  }
  const aws = await execFileP('aws', ['--version'], { encoding: 'utf-8' })
    .then((r) => (r.stdout || r.stderr).trim().split('\n')[0]!)
    .catch(() => null);
  console.log(`aws cli:    ${aws ?? 'no instalada (los runs no podrán consultar aws)'}`);
  // las que anunciaría el daemon con este kit (model solo si el cli lista --model).
  if (claude.version) {
    console.log(`capacidades: ${announcedCapabilities({ hasAws: aws !== null, supported: claude.supported, remoteRepoEdits: cfg?.defaults.remoteRepoEdits, toolsetRender: cfg?.defaults.toolsetRender }).join(' ')}`);
  }
  console.log(`scratch:    ${scratchDir(LEGACY_PLATFORM_ID)}`);
  if (!cfg) return;
  const repos = Object.entries(cfg.repos);
  console.log(`repos:      ${repos.length === 0 ? 'ninguno mapeado (`repos discover <dir>`)' : ''}`);
  repos.forEach(([k, r]) => {
    const flags = deprecatedRepoFlags(r);
    console.log(`  ${k} → ${r.path}${flags.length > 0 ? ` (${flags.join(', ')}: ${REPO_FLAGS_DEPRECATED})` : ''}`);
  });
  const findings = repoFindings(await scanRepos(cfg.repos, scrubEnv(process.env)));
  console.log(`avisos:     ${findings.length === 0 ? 'ninguno' : `${findings.length} (los mismos que ve duckhunt, sin los paths)`}`);
  findings.forEach((f) => console.log(`  ⚠ ${describeFinding(f)}`));
  const accounts = Object.entries(cfg.aws);
  console.log(`cuentas aws: ${accounts.length === 0 ? 'ninguna mapeada (`aws add <account-id> <profile>`)' : ''}`);
  accounts.forEach(([k, a]) => console.log(`  ${k} → perfil ${a.profile}${a.region ? ` (${a.region})` : ''}`));
}
