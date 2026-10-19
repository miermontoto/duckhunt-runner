// `duckhunt-runner status`: si hay un daemon en marcha (daemon-lock.ts), qué kit tiene esta máquina
// (claude, credencial detectada, aws cli, las capacidades que anunciaría el daemon) y qué hay mapeado
// (repos con sus avisos de salud, cuentas aws). diagnóstico local, sin tocar el server: lo que duckhunt
// dice de esta máquina (nombre, pausa, qué acepta, tope de slots, por qué no recibe trabajo y los
// worktrees que el gc conservó) es lo del último claim del daemon (server-state.ts), con su edad (t#465
// P12). también avisa de los flags de repo deprecados (worktree: false, dangerouslySkipPermissions) que
// ya no aplica nada.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { concurrency, configPath, deprecatedRepoFlags, loadStoredConfig, REPO_FLAGS_DEPRECATED } from './config.js';
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

export async function statusCommand(): Promise<void> {
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
    console.log(`capacidades: ${announcedCapabilities({ hasAws: aws !== null, supported: claude.supported, remoteRepoEdits: cfg?.defaults.remoteRepoEdits }).join(' ')}`);
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
