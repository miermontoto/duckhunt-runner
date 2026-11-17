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
// plugins del USUARIO se conservan (sin --restricted, decisión de t#378), salvo las reglas Bash y de
// escritura de su allow, que en lectura se espejan al deny (user-permissions.ts, t#385 y t#434).
// edición no lo lleva: ya ejecuta código del repo con Bash tras la verificación escalonada, y necesita
// su CLAUDE.md.
// memoria nativa (t#434): read y los runs de reglas ya no niegan Edit/Write enteras (sin regla de
// allow solo alcanzan la memoria del cli). un run de reglas con el opt-in local
// --dangerously-skip-permissions no pasa por dontAsk, así que ahí vuelven al deny: sin permisos que
// pedir, Edit/Write sin negar abrirían el repo entero. (desde t#465 P6 el server ya no manda runs de
// reglas: toda conversación es un prompt run; esa rama solo sirve a un server anterior.)
// deny forzados en TODO kit, de lectura y de edición (0.10.2, t#465): el Read del directorio de los
// mcp-config de los runs (run-mcp-config.ts), que llevan el token per-run de cada slot; sin él no se
// lanza nada. y `withoutShell` quita la shell de lectura a un segmento (read-shell-guard.ts: un
// symlink commiteado que sale del cwd): Bash entera al deny y ningún Bash(...) en el allow.
// 0.11.0 (t#465 P12): todo kit de lectura (y los de reglas heredados) niega además a Read las rutas
// reales de las credenciales de esta máquina (secret_paths, secret-paths.ts: su config y su estado,
// $CLAUDE_CONFIG_DIR, AWS_*_FILE y los realpath de la lista genérica del server). y una plantilla
// (run.seed = template, seed_budget) vuelve a llevar --max-budget-usd aunque viaje como prompt run, con la
// misma regla de siempre (solo con api key o un presupuesto de la config); el de turnos, nunca.
// repos adicionales (t#597, capability multi_repo): sus worktrees van en un solo --add-dir tras el mcp-config (el flag es
// variádico: el siguiente `--` lo cierra), y los de solo lectura llevan al deny Edit, Write y NotebookEdit sobre su ruta
// absoluta (readOnlyDirsDeny; con Bash entero no es una jaula: de mejor esfuerzo, como dice el prompt). sin --add-dir
// en el cli, un run con repos adicionales no se lanza (el daemon no anuncia multi_repo sin él).
// --model (0.12.0): `model` ya llega resuelto por el daemon (el run.model del claim, validado por
// parseClaim; si no, defaults.model de la config) y va en todo segmento, también con --resume (cambia el
// modelo de la sesión desde ese turno). sin ninguno no se pasa y manda el default del cli.
// --effort (0.31.0, r#563): `effort` es el run.effort del claim (validado por parseClaim con isRunEffort) y va como
// --model en todo segmento, también con --resume. sin él no se pasa y manda el de la máquina: el `effortLevel` de sus
// settings o el default del cli (el daemon no tiene un defaults.effort: ese ajuste ya es del cli). la máquina no puede
// fijarlo por el env: scrub-env.ts no deja pasar CLAUDE_CODE_EFFORT_LEVEL, que en el cli manda sobre la sesión.
// el árbol de subagentes (run.subagents) va en el env del cli (claudeRunEnv): CLAUDE_CODE_SUBAGENT_MODEL y
// CLAUDE_CODE_SUBAGENT_EFFORT, que scrub-env.ts tampoco deja pasar de la máquina (sin el bloque, nada). precedencia
// leída en el cli 2.1.326: las dos son un DEFAULT, no un tope. el modelo de un subagente sale del `model` de la llamada
// a la tool Agent, si no del `model` del frontmatter de su definición (`inherit` = el del padre, y ahí el env no
// cuenta), si no del env, y si no el del padre; dentro de un workflow manda CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL. solo
// con CLAUDE_CODE_SUBAGENT_MODEL_FORCE el env gana a todo (y el cli quita `model` de la tool), y el daemon no lo pone.
// el esfuerzo igual: el `effort` de la llamada, si no el del frontmatter, si no el env (el cli no tiene un FORCE).
// memoria de las plantillas y los runs de reglas: el deny lo decide el server (tools.disallowed). desde
// t#465 (lote 9) una plantilla puede llegar SIN Edit/Write en el deny (la persona deja la memoria nativa
// encendida, su knob ruleMemory): aquí no cambia nada, porque una plantilla es un prompt run read y
// parseClaim ya deja Edit/Write fuera del deny forzado; solo vuelven al deny en un run de reglas heredado
// con --dangerously-skip-permissions (arriba).
// autonomía (0.15.0, t#527): el permission mode ya llega en claim.permissionMode (default | auto | bypassPermissions,
// validado por parseClaim) y nunca se añade --dangerously-skip-permissions por ella (el opt-in local de los runs de
// reglas sigue como estaba). con `permissions` (un nivel que pregunta) el cli recibe --permission-prompt-tool con la
// tool que sirve el daemon (permission-server.ts) y su env MCP_TOOL_TIMEOUT de margen sobre el ttl de la petición
// (claudeRunEnv): el flag no sale en `claude --help`, así que lo decide la versión del cli (claude.ts).
// volver atrás (0.17.0, t#564): con `resumeAt` (run.resumeAt del claim) la reanudación va con --resume-session-at <uuid>
// y --fork-session: una sesión nueva que solo sabe hasta ese mensaje (la original queda entera). solo tras --resume
// (el reintento desde cero no lo lleva) y con un cli que los acepta (supportsRewind, por versión: están ocultos del
// --help); sin él, el turno no se lanza: reanudar entera sería seguir con lo que la persona descartó.

import { BASH_TOOL, MEMORY_WRITE_TOOLS, PROMPT_PROFILE, RUN_KIND, RUN_SEED, type ClaimedRun, type ClaimResponse, type PromptProfile, type RunEffort, type RunSeed } from './claim.js';
import type { OptionalFlag } from './claude.js';
import { AGENT_PERMISSION_TOOL_ID } from './vendor/runner-protocol/index.js';

// env del cli con el que espera a la tool de permisos: el ttl de la petición más este margen (ms).
export const MCP_TOOL_TIMEOUT_ENV = 'MCP_TOOL_TIMEOUT';
export const PERMISSION_TOOL_TIMEOUT_MARGIN_MS = 120_000;
// env del cli con el modelo y el esfuerzo por defecto de sus subagentes (r#563, ver cabecera).
export const SUBAGENT_MODEL_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL';
export const SUBAGENT_EFFORT_ENV = 'CLAUDE_CODE_SUBAGENT_EFFORT';

export interface ClaudeArgsInput {
  claim: Pick<ClaimResponse, 'tools' | 'permissionMode' | 'maxTurns' | 'maxBudgetUsd' | 'permissions'> & { run: { kind: string; profile: PromptProfile | null; seed?: RunSeed | null } };
  prompt: string;
  mcpConfigFile: string;
  // flags opcionales que `claude --help` lista en esta máquina.
  supported: ReadonlySet<OptionalFlag>;
  resumeSessionId: string | null;
  // modelo resuelto (el del claim o el de la config; ausente = default del cli), presupuesto forzado
  // de la config (0 = nunca) y opt-in local a saltarse permisos del repo.
  model?: string;
  // esfuerzo del claim (r#563; ausente = el de la máquina).
  effort?: RunEffort | null;
  configBudgetUsd?: number;
  skipPermissions: boolean;
  // coste real (api key) frente a suscripción: sin api key el presupuesto sería nominal.
  payingWithApiKey: boolean;
  // reglas del allow de los settings que carga el run, espejadas (mirroredDeny); se aplican a un prompt
  // run read y a los runs de reglas, nunca a uno de edición.
  mirroredDeny?: readonly string[];
  // Read del directorio de mcp-configs (run-mcp-config.ts::runConfigDeny): al deny de todo kit.
  runConfigDeny: readonly string[];
  // Read de las rutas reales de las credenciales de la máquina (secret-paths.ts): al deny de lectura.
  secretPathsDeny?: readonly string[];
  // segmento sin shell de lectura (read-shell-guard.ts::readShellGuard).
  withoutShell?: boolean;
  // el cli acepta --permission-prompt-tool (claude.ts::supportsPermissionPromptTool): sin él, un claim con
  // permissions no se lanza.
  permissionPromptTool?: boolean;
  // uuid del mensaje en el que retomar la sesión en una nueva (solo con resumeSessionId) y si el cli sabe hacerlo
  // (claude.ts::supportsRewind).
  resumeAt?: string | null;
  rewind?: boolean;
  // los directorios de los repos adicionales (t#597) y el deny de los de solo lectura (readOnlyDirsDeny).
  addDirs?: readonly string[];
  readOnlyDirsDeny?: readonly string[];
  // t#636, fase 2 (live-session.ts): el prompt va por stdin en stream-json, no tras `--`.
  liveInput?: boolean;
  // t#636, fase 3: además toma mensajes en vivo y parte sus turnos (solo con liveInput).
  liveTurns?: boolean;
  // t#690 (end-turn.ts): los settings del segmento con el hook que cierra el turno; null = sin ellos.
  settingsFile?: string | null;
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
  if (claim.permissions && !i.permissionPromptTool) {
    throw new Error('el claude instalado no soporta --permission-prompt-tool: actualiza claude code (sin él la conversación no puede preguntarte)');
  }
  if (i.liveInput && !has('--input-format')) {
    throw new Error('el claude instalado no soporta --input-format: actualiza claude code (sin él el proceso no atiende el buzón)');
  }
  const forkAt = i.resumeSessionId ? (i.resumeAt ?? null) : null;
  if (forkAt !== null && !i.rewind) {
    throw new Error('el claude instalado no soporta --resume-session-at: actualiza claude code (sin él la conversación no puede volver atrás)');
  }
  const addDirs = i.addDirs ?? [];
  if (addDirs.length > 0 && !has('--add-dir')) {
    throw new Error('el claude instalado no soporta --add-dir: actualiza claude code (sin él la conversación no ve sus repos adicionales)');
  }
  if (i.runConfigDeny.length === 0 || !has('--disallowedTools')) {
    throw new Error('sin --disallowedTools y el deny del directorio de configs de run no se lanza nada: los mcp-config de los runs quedarían al alcance de Read');
  }
  // presupuesto: solo tiene sentido cuando el coste es REAL (api key). con login de suscripción el
  // cli lo aplicaría sobre un coste nominal que nadie paga y mata runs legítimos (el guard contra
  // loops es el timeout). config manda: número = forzar, 0 = nunca. prompt runs: nunca, salvo los que
  // nacieron de una plantilla (seed_budget).
  const budgeted = !isPrompt || claim.run.seed === RUN_SEED.template;
  const budget = budgeted ? (i.configBudgetUsd ?? (i.payingWithApiKey ? (claim.maxBudgetUsd ?? 0) : 0)) : 0;
  const maxTurns = isPrompt ? 0 : (claim.maxTurns ?? 0);
  const skip = i.skipPermissions && !isPrompt;
  const allowed = i.withoutShell ? claim.tools.allowed.filter((t) => t !== BASH_TOOL && !t.startsWith(`${BASH_TOOL}(`)) : claim.tools.allowed;
  const disallowed = Array.from(
    new Set([
      ...claim.tools.disallowed,
      ...(readPrompt || !isPrompt ? [...(i.mirroredDeny ?? []), ...(i.secretPathsDeny ?? [])] : []),
      ...(skip ? MEMORY_WRITE_TOOLS : []),
      ...(i.withoutShell ? [BASH_TOOL] : []),
      ...(i.readOnlyDirsDeny ?? []),
      ...i.runConfigDeny,
    ]),
  );
  return [
    '-p',
    '--output-format',
    'stream-json',
    ...(i.liveInput ? ['--input-format', 'stream-json'] : []),
    // t#636, fase 3: el acuse de los mensajes que la persona manda en vivo.
    ...(i.liveTurns ? ['--replay-user-messages'] : []),
    ...(has('--verbose') ? ['--verbose'] : []),
    // t#636: lo que dicen los subagentes, con su padre (el feed lo anida); sin el flag el cli solo manda sus tool calls.
    ...(has('--forward-subagent-text') ? ['--forward-subagent-text'] : []),
    '--mcp-config',
    i.mcpConfigFile,
    ...(i.settingsFile && has('--settings') ? ['--settings', i.settingsFile] : []),
    ...(addDirs.length > 0 ? ['--add-dir', ...addDirs] : []),
    ...(has('--strict-mcp-config') ? ['--strict-mcp-config'] : []),
    ...(readPrompt ? ['--setting-sources', 'user'] : []),
    ...(allowed.length > 0 ? ['--allowedTools', allowed.join(',')] : []),
    '--disallowedTools',
    disallowed.join(','),
    '--permission-mode',
    claim.permissionMode,
    ...(claim.permissions ? ['--permission-prompt-tool', AGENT_PERMISSION_TOOL_ID] : []),
    ...(has('--max-turns') && maxTurns > 0 ? ['--max-turns', String(maxTurns)] : []),
    ...(has('--max-budget-usd') && budget > 0 ? ['--max-budget-usd', String(budget)] : []),
    ...(i.model ? ['--model', i.model] : []),
    // un cli sin --effort abortaría con el flag: entonces manda el de la máquina (el daemon tampoco anuncia `effort`).
    ...(i.effort && has('--effort') ? ['--effort', i.effort] : []),
    ...(skip ? ['--dangerously-skip-permissions'] : []),
    ...(i.resumeSessionId ? ['--resume', i.resumeSessionId] : []),
    ...(forkAt !== null ? ['--resume-session-at', forkAt, '--fork-session'] : []),
    // con stdin vivo el prompt es su primer mensaje (live-session.ts).
    ...(i.liveInput ? [] : ['--', i.prompt]),
  ];
}

/** env que el run añade al de sus recursos para `claude`: con la tool de permisos, MCP_TOOL_TIMEOUT con margen sobre el
 *  ttl de la petición (sin bajar uno mayor que ya traiga el env); con el tier de subagentes del claim (r#563), su modelo y
 *  su esfuerzo por defecto. sin ninguno, nada. */
export function claudeRunEnv(base: NodeJS.ProcessEnv, claim: Pick<ClaimResponse, 'permissions'> & { run: Pick<ClaimedRun, 'subagents'> }): Record<string, string> {
  const { permissions } = claim;
  const sub = claim.run.subagents;
  const wanted = permissions ? permissions.ttlMs + PERMISSION_TOOL_TIMEOUT_MARGIN_MS : 0;
  const current = Number(base[MCP_TOOL_TIMEOUT_ENV]);
  return {
    ...(permissions ? { [MCP_TOOL_TIMEOUT_ENV]: String(Number.isSafeInteger(current) && current > wanted ? current : wanted) } : {}),
    ...(sub?.model ? { [SUBAGENT_MODEL_ENV]: sub.model } : {}),
    ...(sub?.effort ? { [SUBAGENT_EFFORT_ENV]: sub.effort } : {}),
  };
}
