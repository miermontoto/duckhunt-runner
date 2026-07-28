// config del runner (~/.duckhunt-runner.json): credencial oauth + mapa repo→path local.
// el server jamás ve estos paths — la resolución repo→checkout vive SOLO aquí.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RepoConfig {
  // path absoluto al checkout local del repo.
  path: string;
  // opt-in explícito per-repo a --dangerously-skip-permissions (decisión del usuario,
  // revisión 2026-07-28). sin él claude corre con sus permisos por defecto.
  dangerouslySkipPermissions?: boolean;
  // aislar cada run en un git worktree (default true). false = correr en el checkout.
  worktree?: boolean;
}

export interface RunnerConfig {
  baseUrl: string;
  clientId: string;
  refreshToken: string;
  // etiqueta del runner en agent_run.runner_label (default: hostname).
  label?: string;
  // mapa target_repo.repo ("workspace/slug") → checkout local.
  repos: Record<string, RepoConfig>;
}

export function configPath(): string {
  return process.env.DUCKHUNT_RUNNER_CONFIG ?? path.join(os.homedir(), '.duckhunt-runner.json');
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
  const cfg = parsed as RunnerConfig;
  if (!cfg.baseUrl || !cfg.clientId || !cfg.refreshToken) {
    throw new Error(`config incompleta en ${file}: ejecuta \`duckhunt-runner login\``);
  }
  return { ...cfg, repos: cfg.repos ?? {} };
}

/** persiste la config con permisos 600 (contiene el refresh token). */
export function saveConfig(cfg: RunnerConfig): void {
  const file = configPath();
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}
