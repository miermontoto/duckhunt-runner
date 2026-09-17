// `duckhunt-runner status`: qué kit tiene esta máquina (claude, credencial detectada, aws cli) y
// qué hay mapeado (repos, cuentas aws). diagnóstico local, sin tocar el server.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { configPath, loadConfig, scratchDir } from './config.js';
import { detectClaude } from './claude.js';

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
  const cfg = loadConfig();
  if (!cfg) {
    console.log(`sin config (${configPath()}): ejecuta \`duckhunt-runner login <base-url>\``);
  } else {
    console.log(`servidor:   ${cfg.baseUrl}`);
    console.log(`runner:     ${cfg.label ?? os.hostname()} (client ${cfg.clientId})`);
    console.log(`modelo:     ${cfg.defaults.model ?? 'default del cli'}`);
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
  console.log(`scratch:    ${scratchDir()}`);
  if (!cfg) return;
  const repos = Object.entries(cfg.repos);
  console.log(`repos:      ${repos.length === 0 ? 'ninguno mapeado (`repos discover <dir>`)' : ''}`);
  repos.forEach(([k, r]) => console.log(`  ${k} → ${r.path}`));
  const accounts = Object.entries(cfg.aws);
  console.log(`cuentas aws: ${accounts.length === 0 ? 'ninguna mapeada (`aws add <account-id> <profile>`)' : ''}`);
  accounts.forEach(([k, a]) => console.log(`  ${k} → perfil ${a.profile}${a.region ? ` (${a.region})` : ''}`));
}
