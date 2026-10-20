// topes de lo que un daemon anuncia en el claim (contrato 42). los de los campos que valida el cuerpo
// (routes/runner.ts::claimBody del server) tumban el claim entero con un 400 si se pasan, así que el daemon
// debe quedarse por debajo; los de presencia (repos, salud, carpetas candidatas, worktrees conservados) se
// recortan o se descartan sin tumbarlo.

// etiqueta de la máquina (runnerLabel).
export const RUNNER_LABEL_MAX_CHARS = 100;
// cuentas aws mapeadas que anuncia (awsAccounts): cuántas y el largo de cada clave.
export const RUNNER_AWS_ACCOUNTS_MAX = 100;
export const RUNNER_AWS_ACCOUNT_MAX_CHARS = 32;

// versiones que el daemon anuncia en el claim (la suya y la de `claude --version`).
export const RUNNER_VERSION_MAX_CHARS = 40;
export const RUNNER_CLAUDE_VERSION_MAX_CHARS = 80;
// capabilities que el daemon anuncia en el claim (t#495). pasarse del tope es un 400 de TODO el claim (no
// se recorta como los repos), así que sube ANTES de que un daemon lo necesite: 0.12 anuncia 13 y el cable
// v0 suma features, attestations y backends. holgado: solo acota lo que se guarda.
export const RUNNER_CAPABILITIES_MAX = 64;
export const RUNNER_CAPABILITY_MAX_CHARS = 40;

// runs en paralelo que anuncia un daemon >= 0.5.0 (su defaults.maxConcurrent, hoy acotado a 8 en
// el runner). tope holgado solo para acotar lo guardado: fuera de rango se ignora, un dato de
// presencia nunca tumba un claim.
export const RUNNER_SLOTS_MAX = 64;

// identidad de la máquina que anuncia un daemon >= 0.11.0 (t#465 P12, campos del claim que no son
// capabilities): machine.id = uuid estable que genera y guarda en su config, y replacesClientId = el
// client_id de su login anterior hasta su primer claim con el nuevo. un claim que casa por
// cualquiera de los dos con OTRA fila de la MISMA persona la adopta (queries/runners.ts): mueve su
// client_id a la fila vieja (id, nombre, ajustes y afinidad intactos), borra la duplicada y revoca la
// credencial vieja salvo los tokens per-run en vuelo. backend {id, version} se guarda y nada más (t#440).
export const RUNNER_MACHINE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const RUNNER_CLIENT_ID_MAX_CHARS = 128;
export const RUNNER_BACKEND_ID_RE = /^[a-z0-9_-]{1,40}$/;
// worktrees conservados que se guardan de un claim (los recuentos, topados): presencia, nunca tumba el claim.
export const RUNNER_KEPT_WORKTREES_MAX = 200;
export const RUNNER_KEPT_COUNT_MAX = 100_000;

// issues por claim (REPO_ISSUES_MAX del runner) y tope del recuento de cada uno.
export const RUNNER_REPO_ISSUES_MAX = 200;
// repos mapeados que se guardan de un claim: por encima se recorta (y se loguea), nunca se
// rechaza — un dato de presencia no tumba el claim (antes, > 500 = 400 y el daemon no reclamaba).
export const RUNNER_REPOS_MAX = 2000;
export const RUNNER_REPO_ISSUE_COUNT_MAX = 10_000;

// carpetas candidatas de un repo que anuncia un daemon >= 0.10.0 (t#463 fase 2): nombre de la
// carpeta + estado git, nunca paths; el id es opaco (lo genera el daemon y solo él lo resuelve).
export const RUNNER_REPO_CANDIDATES_MAX = 20;
export const RUNNER_REPO_CHOICES_MAX = 200;
export const RUNNER_REPO_CANDIDATE_ID_MAX_CHARS = 64;
export const RUNNER_REPO_CANDIDATE_NAME_MAX_CHARS = 200;
export const RUNNER_REPO_CANDIDATE_BRANCH_MAX_CHARS = 250;
