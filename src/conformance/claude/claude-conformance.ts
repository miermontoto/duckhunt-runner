// claude code en el arnés de conformidad (t#440 P6): su cli se detecta como lo detecta el daemon (`--version` y los
// flags opcionales de `--help`, claude.ts), habla la Messages api de anthropic y se le apunta al proveedor guionizado con
// ANTHROPIC_BASE_URL y una api key de mentira, con la telemetría, el tráfico no esencial, los informes de errores y el
// autoupdater apagados.
// decisiones:
// - la api key de mentira manda sobre cualquier login: en el HOME canario no hay otro, y el proveedor no la comprueba.
// - un flag opcional que el daemon quiere y el cli ya no lista (p. ej. --max-turns, quitado del --help en 2.1.322) va
//   como aviso del informe: el arnés vigila la deriva del cli.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OPTIONAL_FLAGS, supportedFlags } from '../../claude.js';
import { V0_BACKEND } from '../../vendor/runner-protocol/index.js';
import { anthropicDialect } from '../anthropic-dialect.js';
import type { CliInfo, ConformanceBackend } from '../conformance-backend.js';
import { launchClaudeProbe } from './claude-launch.js';
import { CLAUDE_PROBES } from './claude-probes.js';

const execFileP = promisify(execFile);
const CLAUDE_COMMAND = 'claude';
const HELP_MAX_BUFFER = 4 * 1024 * 1024;
// la api key de mentira de las sondas (el proveedor guionizado no la mira).
const PROBE_API_KEY = 'sk-ant-conformance-not-a-real-key';
const ON = '1';

/** claude code para el arnés (ver cabecera). */
export const claudeConformance: ConformanceBackend = {
  id: V0_BACKEND.claudeCode,
  command: CLAUDE_COMMAND,
  dialect: anthropicDialect,
  probes: CLAUDE_PROBES,

  async detect(env: NodeJS.ProcessEnv): Promise<CliInfo | null> {
    let version: string;
    try {
      version = (await execFileP(CLAUDE_COMMAND, ['--version'], { env, encoding: 'utf-8' })).stdout.trim();
    } catch (err) {
      console.error(`[conformance] ${CLAUDE_COMMAND} --version falló: ${(err as Error).message}`);
      return null;
    }
    if (!version) return null;
    try {
      const help = (await execFileP(CLAUDE_COMMAND, ['--help'], { env, encoding: 'utf-8', maxBuffer: HELP_MAX_BUFFER })).stdout;
      return { version, flags: [...supportedFlags(help)] };
    } catch (err) {
      // como el daemon (claude.ts::detectClaude): sin --help, sin flags opcionales.
      console.error(`[conformance] ${CLAUDE_COMMAND} --help falló (se asumen flags mínimos): ${(err as Error).message}`);
      return { version, flags: [] };
    }
  },

  providerEnv: (url: string): Record<string, string> => ({
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_API_KEY: PROBE_API_KEY,
    DISABLE_TELEMETRY: ON,
    DISABLE_ERROR_REPORTING: ON,
    DISABLE_AUTOUPDATER: ON,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: ON,
  }),

  notes(cli: CliInfo): string[] {
    const missing = OPTIONAL_FLAGS.filter((f) => !cli.flags.includes(f));
    return missing.length === 0 ? [] : [`flags que el daemon usa y el --help de ${cli.version} no lista: ${missing.join(' ')}`];
  },

  launch: launchClaudeProbe,
};
