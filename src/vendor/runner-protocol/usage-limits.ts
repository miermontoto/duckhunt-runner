// límites de uso de la suscripción de un backend: cuánto lleva gastado la cuenta con la que la máquina corre ese cli en
// cada ventana del plan (la de 5 h y la semanal de claude; la primaria y la secundaria de codex) y cuándo se reinicia.
// viaja opcional, como el contexto (usage.ts), en lo que el daemon informa mientras corre un run: el status y el progreso
// (legacy), el informe de un turno (live.ts) y el lease y el result (v0). sin capability: un server anterior lo descarta.
// decisiones:
// - es de la CUENTA de la máquina, no del run: el server guarda el último por máquina × backend (dos runs en paralelo
//   comparten y pisan el mismo valor; gana el `observedAt` más nuevo).
// - de dónde sale (verificado en r#590/r#593): claude 2.1.326 emite `rate_limit_event` en el stream-json con
//   `rate_limit_info.unifiedWindows.{five_hour,seven_day}` = {utilization 0..1, resetsAt en SEGUNDOS, status} y
//   `isUsingOverage`; codex 0.162.1 da `account/rateLimits/{updated,read}` con `primary`/`secondary` = {usedPercent,
//   windowDurationMins, resetsAt}. opencode corre sobre la api del proveedor: sin ventanas, no informa nada.
// - normalizado en el daemon: `usedRatio` es una fracción (claude ya la da, codex divide su porcentaje entre 100),
//   `resetsAt` va en ms y el status en tres valores; la web no sabe de qué backend vino un número.
// - `windowMins` null = el backend no dijo la duración (claude no la da: el daemon la pone para los ids que conoce).
// - se valida por presencia: unos `limits` sin forma se descartan enteros, nunca un 400 que deje el segmento sin cerrar.
// non-goals: leerlos sin un run en marcha (codex lo permite con `read`: irá en el claim cuando haga falta) y la cuota
// diaria del runner por plataforma (runsPerDay, budgetUsdPerDay), que es local al daemon.

/** estado de una ventana: dentro, cerca del tope (el backend avisa) o agotada. */
export const USAGE_LIMIT_STATUS = {
  allowed: 'allowed',
  warning: 'warning',
  rejected: 'rejected',
} as const;
export type UsageLimitStatus = (typeof USAGE_LIMIT_STATUS)[keyof typeof USAGE_LIMIT_STATUS];

/** ids de ventana que conoce el protocolo (un backend nuevo puede mandar otros que cumplan USAGE_LIMIT_WINDOW_ID_RE). */
export const USAGE_LIMIT_WINDOW = {
  fiveHour: 'five_hour',
  sevenDay: 'seven_day',
  primary: 'primary',
  secondary: 'secondary',
} as const;

export const USAGE_LIMIT_WINDOW_ID_RE = /^[a-z0-9_]{1,40}$/;
/** ventanas por backend que se aceptan (holgado: claude da 2 y codex 2). */
export const USAGE_LIMIT_WINDOWS_MAX = 8;
/** tope de `usedRatio`: con el exceso de pago una ventana puede pasar de 1. */
export const USAGE_LIMIT_RATIO_MAX = 10;
/** tope de `windowMins` (un mes). */
export const USAGE_LIMIT_WINDOW_MINS_MAX = 60 * 24 * 31;

/** una ventana del plan del backend. */
export interface UsageLimitWindow {
  id: string;
  // fracción gastada (0.07 = 7 %), ≥ 0.
  usedRatio: number;
  // epoch ms en que se reinicia; null = no lo dijo.
  resetsAt: number | null;
  // duración de la ventana en minutos; null = no la dijo.
  windowMins: number | null;
  status?: UsageLimitStatus;
}

/** los límites de un backend tal como los vio el daemon en un momento. */
export interface BackendUsageLimits {
  // RunnerBackend (backends.ts); un string para no atar el cable a los que conoce esta versión.
  backend: string;
  // epoch ms de la lectura.
  observedAt: number;
  windows: UsageLimitWindow[];
  // la cuenta está tirando del exceso de pago.
  overage?: boolean;
}

/** lo que añade un daemon a sus informes de un run (todo opcional): los límites del backend que lo corre. */
export interface UsageLimitsFields {
  limits?: BackendUsageLimits;
}
