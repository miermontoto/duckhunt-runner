// códigos de error del cable del runner y su status http.

// errores tipados de los agent runs (queries/agent-run-errors.ts, t#495): código estable (el del sobre de
// error de la spec v0 del runner) y status http de cada uno. ninguno se reintenta: un 404 o un 409 son
// definitivos para quien llama.
export const AGENT_RUN_ERROR_CODE = {
  runNotFound: 'run_not_found',
  runClosed: 'run_closed',
  segmentSuperseded: 'segment_superseded',
  illegalTransition: 'illegal_transition',
} as const;
export type AgentRunErrorCode = (typeof AGENT_RUN_ERROR_CODE)[keyof typeof AGENT_RUN_ERROR_CODE];
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const AGENT_RUN_ERROR_HTTP_STATUS = {
  [AGENT_RUN_ERROR_CODE.runNotFound]: HTTP_NOT_FOUND,
  [AGENT_RUN_ERROR_CODE.runClosed]: HTTP_CONFLICT,
  [AGENT_RUN_ERROR_CODE.segmentSuperseded]: HTTP_CONFLICT,
  [AGENT_RUN_ERROR_CODE.illegalTransition]: HTTP_CONFLICT,
} as const satisfies Record<AgentRunErrorCode, number>;
export type AgentRunErrorHttpStatus = (typeof AGENT_RUN_ERROR_HTTP_STATUS)[AgentRunErrorCode];
