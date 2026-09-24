// argv de `claude -p` para un run. pura (sin env ni fs) para poder probarla: quien la llama resuelve
// antes la config local y los flags que soporta el cli instalado.
// decisiones: el permission mode viaja SIEMPRE (omitido heredaría el defaultMode del usuario, que
// puede ser bypassPermissions) y sin él el run no arranca; los prompt runs (t#378) no llevan
// --max-turns ni --max-budget-usd (el tope es el wall clock por segmento) ni el opt-in local
// --dangerously-skip-permissions (su perfil read|edit lo fija el server y debe cumplirse); el prompt
// va el último tras `--`, así un texto que empiece por '-' nunca se lee como flag.

import { RUN_KIND, type ClaimResponse } from './claim.js';
import type { OptionalFlag } from './claude.js';

export interface ClaudeArgsInput {
  claim: Pick<ClaimResponse, 'tools' | 'permissionMode' | 'maxTurns' | 'maxBudgetUsd'> & { run: { kind: string } };
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
}

/** argv de `claude` (sin el binario). lanza si el cli no puede fijar el permission mode. */
export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const { claim } = i;
  const has = (f: OptionalFlag): boolean => i.supported.has(f);
  const isPrompt = claim.run.kind === RUN_KIND.prompt;
  if (!has('--permission-mode')) {
    throw new Error('el claude instalado no soporta --permission-mode: actualiza claude code (sin él heredaría tus permisos por defecto)');
  }
  // presupuesto: solo tiene sentido cuando el coste es REAL (api key). con login de suscripción el
  // cli lo aplicaría sobre un coste nominal que nadie paga y mata runs legítimos (el guard contra
  // loops es el timeout). config manda: número = forzar, 0 = nunca. prompt runs: nunca.
  const budget = isPrompt ? 0 : (i.configBudgetUsd ?? (i.payingWithApiKey ? (claim.maxBudgetUsd ?? 0) : 0));
  const maxTurns = isPrompt ? 0 : (claim.maxTurns ?? 0);
  return [
    '-p',
    '--output-format',
    'stream-json',
    ...(has('--verbose') ? ['--verbose'] : []),
    '--mcp-config',
    i.mcpConfigFile,
    ...(has('--strict-mcp-config') ? ['--strict-mcp-config'] : []),
    ...(claim.tools.allowed.length > 0 ? ['--allowedTools', claim.tools.allowed.join(',')] : []),
    ...(has('--disallowedTools') && claim.tools.disallowed.length > 0 ? ['--disallowedTools', claim.tools.disallowed.join(',')] : []),
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
