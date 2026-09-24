// entorno de los procesos que lanza el daemon (claude y git). parte del env del usuario (su PATH,
// sus credenciales de git/aws, su login de claude) y quita lo que NO es suyo sino de la sesión desde
// la que se arrancó el daemon: si `duckhunt-runner start` se lanza dentro de una sesión de claude
// code, heredaría CLAUDECODE, CLAUDE_CODE_SESSION_ID, el socket de mensajería… y el `claude -p` del
// run se creería una sesión hija de aquella. del espacio CLAUDE_CODE_* solo pasa una allowlist de
// configuración del usuario (credencial, proveedor, topes). además: vars ANTHROPIC_* vacías fuera
// (una ANTHROPIC_API_KEY vacía rompe el login de suscripción), SSH_AUTH_SOCK muerto fuera (screen y
// systemd heredan sockets de agentes que ya no existen) y git sin prompts de terminal.

import fs from 'node:fs';

// marcadores de sesión fuera del espacio CLAUDE_CODE_*.
const SESSION_VARS = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT']);
const CLAUDE_CODE_PREFIX = 'CLAUDE_CODE_';
// CLAUDE_CODE_* que son configuración del usuario, no de una sesión concreta.
const CLAUDE_CODE_KEEP = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
]);
const ANTHROPIC_PREFIX = 'ANTHROPIC_';

// true si el path es un socket unix vivo.
function isLiveSocket(p: string): boolean {
  try {
    return fs.statSync(p).isSocket();
  } catch {
    // ENOENT u otro fallo de stat: el socket no está.
    return false;
  }
}

/** env saneado para `claude` y `git` del daemon (ver cabecera). no muta el original. */
export function scrubEnv(base: NodeJS.ProcessEnv, socketAlive: (p: string) => boolean = isLiveSocket): NodeJS.ProcessEnv {
  const kept = Object.entries(base).filter(([key, value]) => {
    if (value === undefined) return false;
    if (SESSION_VARS.has(key)) return false;
    if (key.startsWith(CLAUDE_CODE_PREFIX)) return CLAUDE_CODE_KEEP.has(key);
    if (key.startsWith(ANTHROPIC_PREFIX)) return value.trim() !== '';
    if (key === 'SSH_AUTH_SOCK') return socketAlive(value);
    return true;
  });
  // sin tty que conteste: un prompt de credenciales de git colgaría el run hasta el timeout.
  return { ...Object.fromEntries(kept), GIT_TERMINAL_PROMPT: '0' };
}
