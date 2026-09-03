// config del daemon (~/.duckhunt-runner.json): credencial oauth + mapa repo→path local + mapa
// cuenta aws→perfil local + defaults. el server jamás ve estos paths ni perfiles — la resolución
// repo→checkout y cuenta→perfil vive SOLO aquí. ~/.duckhunt-runner/ guarda el scratch dir (runs
// sin repo, donde claude code acumula memoria) y los logs opcionales.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RepoConfig {
  // path absoluto al checkout local del repo.
  path: string;
  // opt-in explícito per-repo a --dangerously-skip-permissions (decisión del usuario).
  dangerouslySkipPermissions?: boolean;
  // aislar cada run en un git worktree (default true). false = correr en el checkout.
  worktree?: boolean;
}

export interface AwsAccountConfig {
  // perfil de ~/.aws/config que la aws cli usa para esa cuenta.
  profile: string;
  region?: string;
}

export interface RunnerDefaults {
  // modelo que se pasa a claude (--model). ausente = el default del cli del usuario.
  model?: string;
  // runs en paralelo (v0: secuencial; el valor se respeta como tope).
  maxConcurrent?: number;
  // presupuesto por run (--max-budget-usd). ausente = automático: el flag solo se pasa si el
  // daemon corre con ANTHROPIC_API_KEY (coste real); con login de suscripción el coste es
  // nominal y el guard contra loops es el timeout. un número lo fuerza; 0 lo desactiva siempre.
  maxBudgetUsd?: number;
}

export interface RunnerConfig {
  baseUrl: string;
  clientId: string;
  refreshToken: string;
  // etiqueta del runner en agent_run.runner_label (default: hostname).
  label?: string;
  // mapa clave ws/slug → checkout local.
  repos: Record<string, RepoConfig>;
  // mapa id de cuenta aws (12 dígitos) → perfil local.
  aws: Record<string, AwsAccountConfig>;
  defaults: RunnerDefaults;
}

export function configPath(): string {
  return process.env.DUCKHUNT_RUNNER_CONFIG ?? path.join(os.homedir(), '.duckhunt-runner.json');
}

/** directorio de estado del daemon (scratch + logs). */
export function runnerHome(): string {
  return process.env.DUCKHUNT_RUNNER_HOME ?? path.join(os.homedir(), '.duckhunt-runner');
}

/** cwd FIJO de los runs sin repo: la auto-memory de claude code se indexa por ruta, así el
 *  conocimiento de infra (alarmas sin código) acumula entre runs. */
export function scratchDir(): string {
  const dir = path.join(runnerHome(), 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function logsDir(): string {
  const dir = path.join(runnerHome(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** carga la config; null si no existe (login pendiente). lanza si el json es inválido. */
export function loadConfig(): RunnerConfig | null {
  const file = configPath();
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config inválida en ${file}: ${(err as Error).message}`);
  }
  const cfg = parsed as Partial<RunnerConfig>;
  if (!cfg.baseUrl || !cfg.clientId || !cfg.refreshToken) {
    throw new Error(`config incompleta en ${file}: ejecuta \`duckhunt-runner login <base-url>\``);
  }
  return {
    baseUrl: cfg.baseUrl,
    clientId: cfg.clientId,
    refreshToken: cfg.refreshToken,
    label: cfg.label,
    repos: cfg.repos ?? {},
    aws: cfg.aws ?? {},
    defaults: cfg.defaults ?? {},
  };
}

/** persiste la config con permisos 600 (contiene el refresh token). */
export function saveConfig(cfg: RunnerConfig): void {
  const file = configPath();
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}
