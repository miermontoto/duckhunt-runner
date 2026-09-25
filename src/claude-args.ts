// argv de `claude -p` para un run. pura (sin env ni fs) para poder probarla: quien la llama resuelve
// antes la config local y los flags que soporta el cli instalado.
// decisiones: el permission mode viaja SIEMPRE (omitido heredaría el defaultMode del usuario, que
// puede ser bypassPermissions) y sin él el run no arranca; los prompt runs (t#378) no llevan
// --max-turns ni --max-budget-usd (el tope es el wall clock por segmento) ni el opt-in local
// --dangerously-skip-permissions (su perfil read|edit lo fija el server y debe cumplirse); el prompt
// va el último tras `--`, así un texto que empiece por '-' nunca se lee como flag.
// un prompt run SIEMPRE lleva --strict-mcp-config (un .mcp.json del checkout no carga nada). uno de
// LECTURA además lleva `--setting-sources user`: corre en un checkout de origin/<rama> que puede
// haber empujado cualquiera, y su .claude/settings.json (hooks, apiKeyHelper, statusLine…) se
// ejecutaría sin preguntar, y lectura promete que no se ejecuta código del repo. verificado con el
// cli 2.1.281: sin el flag el hook SessionStart del repo corre; con él no (y tampoco carga el
// CLAUDE.md del proyecto: el prompt de lectura le pide leerlo con Read). los settings, hooks y
// plugins del USUARIO se conservan (sin --restricted, decisión de t#378), salvo las reglas Bash de
// su allow, que en lectura se espejan al deny (user-permissions.ts, t#385). edición no lo lleva: ya
// ejecuta código del repo con Bash tras la verificación escalonada, y necesita su CLAUDE.md.

import { PROMPT_PROFILE, RUN_KIND, type ClaimResponse, type PromptProfile } from './claim.js';
import type { OptionalFlag } from './claude.js';

export interface ClaudeArgsInput {
  claim: Pick<ClaimResponse, 'tools' | 'permissionMode' | 'maxTurns' | 'maxBudgetUsd'> & { run: { kind: string; profile: PromptProfile | null } };
  prompt: string;
  mcpConfigFile: string;
  // flags opcionales que `claude --help` lista en esta máquina.
  supported: ReadonlySet<OptionalFlag>;
  resumeSessionId: string | null;
  // config local: modelo, presupuesto forzado (0 = nunca) y opt-in a saltarse permisos del repo.
  model?: string;
  configBudgetUsd?: number;
  skipPermissions: boolean;
  // coste real (api key) frente a suscripción: sin api key el presupuesto sería nominal.
  payingWithApiKey: boolean;
  // reglas Bash del allow del usuario espejadas (userBashDeny); solo se aplican a un prompt run read.
  userBashDeny?: readonly string[];
}

/** flags sin los que el cli no puede cumplir un prompt run (el daemon solo anuncia `prompt` si los tiene todos). */
export const PROMPT_REQUIRED_FLAGS: readonly OptionalFlag[] = ['--permission-mode', '--strict-mcp-config', '--disallowedTools', '--setting-sources'];

/** argv de `claude` (sin el binario). lanza si el cli no puede cumplir el perfil del run. */
export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const { claim } = i;
  const has = (f: OptionalFlag): boolean => i.supported.has(f);
  const isPrompt = claim.run.kind === RUN_KIND.prompt;
  const readPrompt = isPrompt && claim.run.profile === PROMPT_PROFILE.read;
  if (!has('--permission-mode')) {
    throw new Error('el claude instalado no soporta --permission-mode: actualiza claude code (sin él heredaría tus permisos por defecto)');
  }
  const missing = isPrompt ? PROMPT_REQUIRED_FLAGS.filter((f) => !has(f)) : [];
  if (missing.length > 0) {
    throw new Error(`el claude instalado no soporta ${missing.join(', ')}: actualiza claude code (sin ellos un prompt run no cumple su perfil)`);
  }
  // presupuesto: solo tiene sentido cuando el coste es REAL (api key). con login de suscripción el
  // cli lo aplicaría sobre un coste nominal que nadie paga y mata runs legítimos (el guard contra
  // loops es el timeout). config manda: número = forzar, 0 = nunca. prompt runs: nunca.
  const budget = isPrompt ? 0 : (i.configBudgetUsd ?? (i.payingWithApiKey ? (claim.maxBudgetUsd ?? 0) : 0));
  const maxTurns = isPrompt ? 0 : (claim.maxTurns ?? 0);
  const disallowed = Array.from(new Set([...claim.tools.disallowed, ...(readPrompt ? (i.userBashDeny ?? []) : [])]));
  return [
    '-p',
    '--output-format',
    'stream-json',
    ...(has('--verbose') ? ['--verbose'] : []),
    '--mcp-config',
    i.mcpConfigFile,
    ...(has('--strict-mcp-config') ? ['--strict-mcp-config'] : []),
    ...(readPrompt ? ['--setting-sources', 'user'] : []),
    ...(claim.tools.allowed.length > 0 ? ['--allowedTools', claim.tools.allowed.join(',')] : []),
    ...(has('--disallowedTools') && disallowed.length > 0 ? ['--disallowedTools', disallowed.join(',')] : []),
    '--permission-mode',
    claim.permissionMode,
    ...(has('--max-turns') && maxTurns > 0 ? ['--max-turns', String(maxTurns)] : []),
    ...(has('--max-budget-usd') && budget > 0 ? ['--max-budget-usd', String(budget)] : []),
    ...(i.model ? ['--model', i.model] : []),
    ...(i.skipPermissions && !isPrompt ? ['--dangerously-skip-permissions'] : []),
    ...(i.resumeSessionId ? ['--resume', i.resumeSessionId] : []),
    '--',
    i.prompt,
  ];
}
