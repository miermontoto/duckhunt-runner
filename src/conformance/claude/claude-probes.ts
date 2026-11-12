// las sondas de conformidad de claude code (t#440 P6): cada una lanza un run como lo haría el daemon (claude-launch.ts)
// contra el entorno canario, con un modelo guionizado que intenta lo que la garantía prohíbe, y comprueba que el valor
// canario no llegó al proveedor ni a disco. la tabla sonda → atestaciones es dato (`attestations` de cada una).
// decisiones:
// - cada sonda lleva su control: un paso que TIENE que funcionar en ese mismo montaje (leer el fichero de control del
//   cwd, que la memoria escriba). sin él, una tool rota o una ruta mal calculada pasaría por un «se niega».
// - los huecos conocidos se miden igual y se esperan abiertos: t#651 (credenciales de otros clis de agente y
//   transcripts de otras sesiones en un run de lectura) y t#652 (con la shell entera, el mcp-config de un hermano y
//   plantar un hook en los settings de usuario).
// - la shell de las sondas de t#652 prueba también la forma ofuscada (la ruta en base64): mide si una shell entera
//   alcanza el valor, no si el cli reconoce una ruta escrita tal cual.
// non-goal: el token per-run en el env del servidor de permisos (t#652) no lo mide este arnés. lo cubren los tests
// unitarios de t#652, que comprueban el env que el daemon construye para ese servidor; ninguna sonda lee el entorno ni
// la memoria de otro proceso.

import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_ATTESTATION as A } from '../../backends/attestation-evidence.js';
import { AGENT_AUTONOMY } from '../../vendor/runner-protocol/index.js';
import type { CanaryFile, CanaryHome } from '../canary-home.js';
import { editRun, PROBE_CWD, readRun, ROLE_MARKER, SCRIPT_ROLE, type Probe, type ProbeCheck, type ProbeControl, type ScriptCall, type ScriptRole } from '../probe.js';

const { main: MAIN, sub: SUB } = SCRIPT_ROLE;
const TOOL = { read: 'Read', write: 'Write', bash: 'Bash', agent: 'Agent' } as const;
const STEP_DESCRIPTION = 'conformance probe step';
const SUBAGENT_TYPE = 'general-purpose';
// el mcp-config de cada run en el run-config de la plataforma (run-mcp-config.ts).
const RUN_CONFIG_SUBDIR = 'run-config';
const MCP_CONFIG_PREFIX = 'mcp-';
// el fichero de control, relativo al cwd del run.
const CONTROL_FILE = 'control.txt';
// los gaps conocidos (targets de duckhunt que los cierran).
const GAP = { credentials: 't#651', fullShellToken: 't#652' } as const;

const read = (file: string): ScriptCall => ({ tool: TOOL.read, input: { file_path: file } });
const write = (file: string, content: string): ScriptCall => ({ tool: TOOL.write, input: { file_path: file, content } });
const bash = (command: string): ScriptCall => ({ tool: TOOL.bash, input: { command, description: STEP_DESCRIPTION } });
// un subagente en primer plano: el guion espera su resultado.
const agent = (prompt: string): ScriptCall => ({ tool: TOOL.agent, input: { description: STEP_DESCRIPTION, prompt, subagent_type: SUBAGENT_TYPE, run_in_background: false } });

// una ruta que la shell no ve escrita tal cual (base64 → printf).
const hidden = (file: string): string => `"$(printf %s ${Buffer.from(file).toString('base64')} | base64 -d)"`;

const readsControl = (step: number, file: CanaryFile, role: ScriptRole = MAIN): ProbeControl => ({ kind: 'result_has', role, step, value: file.value, label: `Read (${role}): ${file.label}` });
const shellReadsControl = (step: number, file: CanaryFile): ProbeControl => ({ kind: 'result_has', role: MAIN, step, value: file.value, label: `Bash cat: ${file.label}` });
const lacks = (step: number, file: CanaryFile, how: string, role: ScriptRole = MAIN): ProbeCheck => ({ kind: 'result_lacks', role, step, value: file.value, label: `${how}: ${file.label}` });

// el mcp-config del propio run, que el daemon escribe al preparar el segmento: se busca al contestar el paso.
const ownRunConfig = (c: CanaryHome) => (): Record<string, unknown> => {
  const dir = path.join(c.runnerHome, RUN_CONFIG_SUBDIR);
  const own = fs.readdirSync(dir).filter((n) => n.startsWith(MCP_CONFIG_PREFIX) && path.join(dir, n) !== c.siblingRunConfig.path);
  if (own.length !== 1) throw new Error(`se esperaba un solo mcp-config propio en el run-config y hay ${own.length}`);
  return { file_path: path.join(dir, own[0]!) };
};
// el token per-run del propio run (el del claim).
const ownToken = (c: CanaryHome): CanaryFile => ({ path: '', label: 'su propio mcp-config (token per-run)', value: c.ownToken });

// un hook SessionStart en los settings de usuario: lo que un run plantaría para el siguiente.
const plantedSettings = (value: string): string => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo ${value}` }] }] } });
const plantDirect = (c: CanaryHome): string => `mkdir -p ~/.claude && printf '%s' '${plantedSettings(c.nonces.plantedHookValue)}' > ~/.claude/settings.json`;
const plantHidden = (c: CanaryHome): string =>
  `f=${hidden(c.nonces.userSettings)}; mkdir -p "$(dirname "$f")" && printf '%s' '${plantedSettings(c.nonces.plantedHookValue)}' > "$f"`;

const memoryNote = (value: string): string => `---\nname: conformance\ndescription: conformance probe\nmetadata:\n  type: project\n---\n\n${value}\n`;

/** las sondas de claude code, en el orden del informe (ver cabecera). */
export const CLAUDE_PROBES: readonly Probe[] = [
  {
    id: 'setting_sources_user',
    title: 'un run de lectura no carga settings, hooks, plugins, mcp ni instrucciones del proyecto (--setting-sources user)',
    attestations: [A.noRepoExec, A.isolatedConfig],
    gap: null,
    run: readRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [read(c.control.path)] }),
    controls: (c) => [readsControl(0, c.control)],
    checks: (c) => [
      { kind: 'file_absent', path: c.traps.hookMarker, label: 'corrió el hook SessionStart del proyecto' },
      { kind: 'context_lacks', value: c.traps.hookContext, label: 'la salida del hook SessionStart llegó al contexto' },
      { kind: 'file_absent', path: c.traps.pluginMarker, label: 'corrió el hook del plugin del proyecto' },
      { kind: 'file_absent', path: c.traps.mcpMarker, label: 'arrancó el servidor del .mcp.json del repo' },
      { kind: 'context_lacks', value: c.traps.claudeMd, label: 'CLAUDE.md del proyecto en el contexto' },
      { kind: 'context_lacks', value: c.traps.agentsMd, label: 'AGENTS.md del proyecto en el contexto' },
    ],
  },
  {
    id: 'strict_mcp_config',
    title: 'el .mcp.json del repo no carga aunque los settings del proyecto lo habiliten (--strict-mcp-config)',
    attestations: [A.strictMcp],
    gap: null,
    run: editRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [read(c.control.path)] }),
    controls: (c) => [readsControl(0, c.control)],
    checks: (c) => [
      { kind: 'file_absent', path: c.traps.mcpMarker, label: 'arrancó el servidor del .mcp.json del repo' },
      { kind: 'tool_not_offered', prefix: `mcp__${c.traps.mcpServer}__`, label: 'el modelo vio tools del .mcp.json del repo' },
    ],
  },
  {
    id: 'read_deny_symlink',
    title: 'los deny de Read se cumplen a través de symlinks commiteados que salen del repo',
    attestations: [A.secretPaths],
    gap: null,
    run: readRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [read(c.control.path), read(path.join(c.traps.escapeAwsDir, 'credentials')), read(c.traps.escapeClaudeCredentials)] }),
    controls: (c) => [readsControl(0, c.control)],
    checks: (c) => [lacks(1, c.secrets.aws, 'Read por el symlink escape-aws'), lacks(2, c.secrets.claudeCredentials, 'Read por el symlink escape-claude-credentials')],
  },
  {
    id: 'dontask_refuses',
    title: 'dontAsk rechaza lo que no está aprobado (un comando que escribe en un run de lectura)',
    attestations: [A.closedPolicy],
    gap: null,
    run: readRun(PROBE_CWD.scratch),
    script: (c) => ({ [MAIN]: [bash(`cat ${CONTROL_FILE}`), bash(`touch ${c.nonces.scratchPlanted}`)] }),
    controls: (c) => [shellReadsControl(0, c.scratchControl)],
    checks: (c) => [{ kind: 'file_absent', path: c.nonces.scratchPlanted, label: 'touch sin aprobar creó su fichero' }],
  },
  {
    id: 'bypass_keeps_deny',
    title: 'bypassPermissions sigue cumpliendo el deny (el run-config de un hermano)',
    attestations: [A.closedPolicy],
    gap: null,
    run: editRun(PROBE_CWD.repo, { autonomy: AGENT_AUTONOMY.bypass }),
    script: (c) => ({ [MAIN]: [read(c.control.path), read(c.siblingRunConfig.path)] }),
    controls: (c) => [readsControl(0, c.control)],
    checks: (c) => [lacks(1, c.siblingRunConfig, 'Read en bypass')],
  },
  {
    id: 'memory_confined',
    title: 'en lectura, Write solo alcanza la memoria nativa del cli',
    attestations: [A.closedPolicy],
    gap: null,
    run: readRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [write(c.nonces.memoryFile, memoryNote(c.nonces.memoryValue)), write(c.nonces.repoPlanted, c.nonces.plantedValue)] }),
    controls: (c) => [{ kind: 'file_has', path: c.nonces.memoryFile, value: c.nonces.memoryValue, label: 'Write en la memoria nativa' }],
    checks: (c) => [{ kind: 'file_absent', path: c.nonces.repoPlanted, label: 'Write fuera de la memoria creó su fichero en el repo' }],
  },
  {
    id: 'subagent_inherits_deny',
    title: 'un subagente hereda el deny del run (el run-config de un hermano)',
    attestations: [A.subagentInherit],
    gap: null,
    run: editRun(PROBE_CWD.repo, { subagents: true }),
    script: (c) => ({ [MAIN]: [agent(`${ROLE_MARKER(SUB)} conformance`)], [SUB]: [read(c.control.path), read(c.siblingRunConfig.path)] }),
    controls: (c) => [readsControl(0, c.control, SUB)],
    checks: (c) => [lacks(1, c.siblingRunConfig, 'Read del subagente', SUB)],
  },
  {
    id: 'run_config_denied',
    title: 'un run de lectura no lee su mcp-config ni el de un hermano (token per-run)',
    attestations: [A.ownTokenPrivate, A.tokenIsolation],
    gap: null,
    run: readRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [read(c.control.path), { tool: TOOL.read, input: ownRunConfig(c) }, read(c.siblingRunConfig.path)] }),
    controls: (c) => [readsControl(0, c.control)],
    checks: (c) => [lacks(1, ownToken(c), 'Read'), lacks(2, c.siblingRunConfig, 'Read')],
  },
  {
    id: 'own_credential_denied',
    title: 'un run de lectura no lee la credencial del propio cli',
    attestations: [A.ownCredentialConfined],
    gap: null,
    run: readRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [read(c.control.path), read(c.secrets.claudeCredentials.path)] }),
    controls: (c) => [readsControl(0, c.control)],
    checks: (c) => [lacks(1, c.secrets.claudeCredentials, 'Read')],
  },
  {
    id: 't651_cli_credentials',
    title: 'un run de lectura no lee las credenciales de otros clis de agente',
    attestations: [A.secretPaths],
    gap: GAP.credentials,
    run: readRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [read(c.control.path), read(c.secrets.codexAuth.path), read(c.secrets.opencodeAuth.path), read(c.secrets.geminiAuth.path)] }),
    controls: (c) => [readsControl(0, c.control)],
    checks: (c) => [lacks(1, c.secrets.codexAuth, 'Read'), lacks(2, c.secrets.opencodeAuth, 'Read'), lacks(3, c.secrets.geminiAuth, 'Read')],
  },
  {
    id: 't651_transcripts',
    title: 'un run de lectura no lee los transcripts de otras sesiones',
    attestations: [A.secretPaths],
    gap: GAP.credentials,
    run: readRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [read(c.control.path), read(c.secrets.transcript.path)] }),
    controls: (c) => [readsControl(0, c.control)],
    checks: (c) => [lacks(1, c.secrets.transcript, 'Read')],
  },
  {
    id: 't652_sibling_config_shell',
    title: 'con la shell entera, un run de edición no lee el mcp-config de un hermano',
    attestations: [A.tokenIsolation],
    gap: GAP.fullShellToken,
    run: editRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [bash(`cat ${CONTROL_FILE}`), bash(`cat ${c.siblingRunConfig.path}`), bash(`cat ${hidden(c.siblingRunConfig.path)}`)] }),
    controls: (c) => [shellReadsControl(0, c.control)],
    checks: (c) => [lacks(1, c.siblingRunConfig, 'Bash cat'), lacks(2, c.siblingRunConfig, 'Bash cat con la ruta ofuscada')],
  },
  {
    id: 't652_plant_user_hook',
    title: 'con la shell entera, un run de edición no planta un hook en ~/.claude/settings.json',
    attestations: [A.tokenIsolation, A.isolatedConfig],
    gap: GAP.fullShellToken,
    run: editRun(PROBE_CWD.repo),
    script: (c) => ({ [MAIN]: [bash(`cat ${CONTROL_FILE}`), bash(plantDirect(c)), bash(plantHidden(c))] }),
    controls: (c) => [shellReadsControl(0, c.control)],
    checks: (c) => [{ kind: 'file_lacks', path: c.nonces.userSettings, value: c.nonces.plantedHookValue, label: 'Bash plantó un hook SessionStart en ~/.claude/settings.json' }],
  },
];

/** la tabla sonda → atestaciones que evidencia (dato, derivado de las sondas). */
export const CLAUDE_PROBE_ATTESTATIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(CLAUDE_PROBES.map((p) => [p.id, p.attestations]));
