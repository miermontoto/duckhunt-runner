// capacidades que el daemon anuncia en cada claim, según el kit de esta máquina (cli de claude, aws
// cli, config). pura para poder probarla: el daemon le pasa lo que detectó al arrancar y su config
// recargada. el server decide con ellas qué entrega y cómo (ver RUNNER_CAPABILITY en claim.ts).

import { RUNNER_CAPABILITY, type RunnerCapability } from './claim.js';
import { PROMPT_REQUIRED_FLAGS } from './claude-args.js';
import type { OptionalFlag } from './claude.js';

export interface MachineKit {
  // aws cli instalada.
  hasAws: boolean;
  // flags opcionales que `claude --help` lista en esta máquina.
  supported: ReadonlySet<OptionalFlag>;
  // defaults.remoteRepoEdits de la config (false = el mapa de repos solo se cambia por la cli).
  remoteRepoEdits?: boolean;
  // defaults.toolsetRender de la config (false = el interruptor del flip de toolset_v1: solo en sombra, como 0.13).
  toolsetRender?: boolean;
  // odysea hallado en la máquina (t#495, M7): sabe poner una sesión de navegador en un run.
  browser?: boolean;
}

/** capacidades del claim: prompt (y lo que va con él) solo si el cli puede cumplir su perfil, model solo con --model. */
export function announcedCapabilities(kit: MachineKit): RunnerCapability[] {
  return [
    ...(kit.hasAws ? [RUNNER_CAPABILITY.aws] : []),
    // read_shell y native_memory van con prompt: exigen poder cumplir el perfil read (parseClaim lo
    // valida) y pasar el deny espejado (--disallowedTools).
    ...(PROMPT_REQUIRED_FLAGS.every((f) => kit.supported.has(f))
      ? [RUNNER_CAPABILITY.prompt, RUNNER_CAPABILITY.readShell, RUNNER_CAPABILITY.nativeMemory]
      : []),
    RUNNER_CAPABILITY.events,
    RUNNER_CAPABILITY.checkout,
    ...(kit.remoteRepoEdits === false ? [] : [RUNNER_CAPABILITY.repoEdit]),
    RUNNER_CAPABILITY.secretPaths,
    RUNNER_CAPABILITY.seedBudget,
    RUNNER_CAPABILITY.awsStrict,
    RUNNER_CAPABILITY.worktreeReport,
    RUNNER_CAPABILITY.logout,
    // al final: el orden de las anteriores no cambia para el server.
    ...(kit.supported.has('--model') ? [RUNNER_CAPABILITY.model] : []),
    // toolset_v1 en sombra (t#495, M5): solo lo renderiza y compara (toolset/shadow.ts); las listas siguen mandando.
    RUNNER_CAPABILITY.toolsetV1,
    // el flip (t#495, M5): lanza los runs de duckhunt con su render (toolset/legacy-render.ts). salvo el interruptor.
    ...(kit.toolsetRender === false ? [] : [RUNNER_CAPABILITY.toolsetRender]),
    // sesiones de navegador (t#495, M7): con odysea y con el flip (las tools del navegador solo las pinta el render).
    ...(kit.browser && kit.toolsetRender !== false ? [RUNNER_CAPABILITY.browser] : []),
  ];
}
