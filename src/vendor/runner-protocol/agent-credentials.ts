// rutas de credenciales y de sesiones de otros clis de agente, relativas a ~ (t#651): un run de lectura las niega con
// Read. el server las envuelve como Read(~/<p>) en AGENT_SECRET_READ_DENY y el runner las espeja (toolset/render.ts) y
// añade sus realpaths reubicados (secret-paths.ts). los .md de memoria nativa siguen legibles (solo se niega .jsonl).
export const AGENT_CLI_CREDENTIAL_PATHS: readonly string[] = [
  // codex: credenciales e historial/sesiones
  '.codex/auth.json',
  '.codex/sessions/**',
  '.codex/history.jsonl',
  '.codex/session_index.jsonl',
  '.codex/thread_history_*.sqlite',
  // opencode: data y config (auth.json legacy + store sqlite v2)
  '.local/share/opencode/**',
  '.config/opencode/**',
  // amp: settings + secrets
  '.config/amp/settings.json',
  '.config/amp/settings.jsonc',
  '.local/share/amp/secrets.json',
  // gemini cli: oauth
  '.gemini/oauth_creds.json',
  '.gemini/google_accounts.json',
  // github copilot cli: fallback en fichero plano (si no hay keychain)
  '.copilot/config.json',
  // goose: secrets + sesiones
  '.config/goose/secrets.yaml',
  '.config/goose/sessions/**',
  '.local/share/goose/**',
  // cursor agent cli
  '.cursor/cli-config.json',
  // transcripts de otras sesiones/runs de claude code, de cualquier espacio (camino de lectura entre espacios, t#628)
  '.claude/projects/**/*.jsonl',
];
