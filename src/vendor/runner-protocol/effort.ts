// esfuerzo de razonamiento de un segmento (r#563): los niveles que el claim puede pedir (`run.effort`) y que el daemon
// pasa al cli tal cual (`claude --effort <nivel>`, cli >= 2.1.3xx: low · medium · high · xhigh · max).
//
// decisiones:
// - viaja el nivel ya resuelto: «auto» y «el de la máquina» son elecciones del server (su AGENT_EFFORT_CHOICE) y nunca
//   llegan al cable. null o ausente = el daemon no pasa `--effort` y manda su config o el default del cli.
// - el daemon valida contra RUN_EFFORT_LEVELS antes de montar argv: un nivel que no conoce se ignora con un aviso y el
//   segmento corre con el esfuerzo de la máquina (un esfuerzo raro no merece tumbar el claim).
// - el orden de RUN_EFFORT_LEVELS es de menos a más: lo usan el server (suelo y techo de «auto») y la web.

export const RUN_EFFORT = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const;
export type RunEffort = (typeof RUN_EFFORT)[keyof typeof RUN_EFFORT];

/** los niveles de menos a más esfuerzo. */
export const RUN_EFFORT_LEVELS: readonly RunEffort[] = [RUN_EFFORT.low, RUN_EFFORT.medium, RUN_EFFORT.high, RUN_EFFORT.xhigh, RUN_EFFORT.max];

/** ¿es un nivel de esfuerzo del cable? lo que valida el daemon antes de pasarlo a `--effort`. */
export function isRunEffort(value: unknown): value is RunEffort {
  return typeof value === 'string' && (RUN_EFFORT_LEVELS as readonly string[]).includes(value);
}
