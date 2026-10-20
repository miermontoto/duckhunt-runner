// capabilities que el daemon anuncia en el claim (contrato 42): con ellas el server decide qué le manda (un
// daemon que no anuncia una nunca recibe lo que la necesita) y el daemon las anuncia según su versión y su
// máquina. un id nuevo se añade aquí y en ninguna otra parte del server.

// capacidades que el daemon anuncia en el claim. sin `prompt` (0.3.x, o un 0.4+ cuyo cli no tiene los
// flags del perfil read) el daemon no recibe NADA (t#465): 204 + RUNNER_STATE_HEADER upgrade_required,
// porque toda conversación, también una investigación, viaja como prompt run de lectura y uno viejo
// la ejecutaría a ciegas con su kit de reglas. el feed solo se pide a quien anuncia `events`.
export const RUNNER_CAPABILITY = {
  aws: 'aws',
  prompt: 'prompt',
  events: 'events',
  // >= 0.6.0: un prompt run puede trabajar en el checkout del repo (AGENT_RUN_ISOLATION.checkout).
  checkout: 'checkout',
  // >= 0.7.0: acepta shell de solo lectura en un claim read (t#385): sin deny de Bash entero y con
  // `Bash(aws …)` con forma de lectura. sin ella read sigue sin shell (un daemon viejo rechazaría el
  // claim entero); los patrones aws además exigen `aws` (cli instalada).
  readShell: 'read_shell',
  // >= 0.8.0 (t#434): acepta un run de lectura o de reglas sin Edit/Write negadas enteras (su
  // memoria nativa) y lo cumple: nunca las admite en el allow de lectura y espeja al deny las reglas
  // Edit/Write del allow de los settings que carga el run. sin ella siguen negadas enteras.
  nativeMemory: 'native_memory',
  // >= 0.10.0 (t#463): aplica los cambios del mapa de repos encolados desde duckhunt (quitar un repo,
  // elegir su carpeta entre los candidatos que anunció). el usuario puede apagarlo en la máquina.
  repoEdit: 'repo_edit',
  // >= 0.11.0 (t#465 P12): añade al deny de todo kit de lectura las rutas REALES de las credenciales de
  // la máquina (su config, su estado, $CLAUDE_CONFIG_DIR, AWS_*_FILE): las que AGENT_SECRET_READ_DENY,
  // genérica y relativa a ~, no puede saber. el server nunca las ve.
  secretPaths: 'secret_paths',
  // >= 0.11.0: aplica maxBudgetUsd a las semillas de plantilla aunque viajen como prompt run (solo con
  // api key o un presupuesto de su config, como siempre). antes iba a 0 en todo prompt run.
  seedBudget: 'seed_budget',
  // >= 0.11.0: una cuenta aws del run que la máquina no mapea corre con la config de aws vacía (falla
  // cerrado) en vez de caer en el perfil por defecto, que podría ser otra cuenta.
  awsStrict: 'aws_strict',
  // >= 0.11.0: anuncia en el claim `keptWorktrees` (recuentos por run, nunca paths) de los worktrees de
  // conversación que su gc conservó porque guardan trabajo; el hilo lo enseña (pedir commit).
  worktreeReport: 'worktree_report',
  // >= 0.11.0: `duckhunt-runner logout` (POST /api/runner/unpair) y el bloque `runner` de la respuesta
  // del claim (también sin trabajo: 200 con run null). la fila de /settings sugiere el comando.
  logout: 'logout',
  // >= 0.12.0 (t#465): acepta `run.model` en el claim (alias o id, AGENT_MODEL_ID_RE) y lo pasa a
  // `--model`; null = su defaults.model o el default del cli. lo anuncia solo si su cli tiene `--model`.
  // sin ella el run no lleva la clave (el cable de siempre) y corre con el modelo de la máquina.
  model: 'model',
} as const;
export type RunnerCapability = (typeof RUNNER_CAPABILITY)[keyof typeof RUNNER_CAPABILITY];
