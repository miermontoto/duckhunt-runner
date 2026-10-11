// lo último que duckhunt le dijo a este daemon de su máquina (0.11.0, t#465 P12): el bloque `runner` del
// claim (el nombre que le puso la persona, su pausa, qué acepta y su tope de slots), el motivo de la
// cabecera x-duckhunt-runner-state (en pausa, sin slot, actualizar) y los worktrees que su gc conservó con
// trabajo (recuentos). el daemon lo escribe en <runnerHome>/server-state.json (0600, atómico) cuando
// cambia y, si no, como mucho cada SERVER_STATE_TOUCH_MS, y `status` lo lee con su edad.
// decisiones:
// - `status` no habla con el server: refrescar la credencial desde otro proceso rotaría el refresh token
//   del daemon en marcha y duckhunt lo trataría como un replay (revocaría la cadena entera). lo que
//   imprime es lo del último claim, con cuándo fue.
// - no lleva secretos: ni tokens ni paths (lo mismo que el server ya sabe). `logout` lo borra.
// - un server anterior a 0.11 no manda el bloque (204 sin cuerpo): queda runner null y el estado de la
//   cabecera si la hubo.

import fs from 'node:fs';
import path from 'node:path';
import { runnerHome } from './config.js';

const SERVER_STATE_FILE = 'server-state.json';
const SERVER_STATE_MODE = 0o600;
// sin cambios, se reescribe como mucho con esta cadencia (solo para que `status` sepa la edad).
export const SERVER_STATE_TOUCH_MS = 60_000;
// estados que no vienen de la cabecera: el claim entregó un run, o la credencial ya no vale.
export const CLAIM_OUTCOME = { claimed: 'claimed', unpaired: 'unpaired' } as const;

/** la fila de esta máquina en duckhunt tal como la manda el claim. */
export interface RunnerBlock {
  id: number;
  name: string | null;
  paused: boolean;
  accepts: string;
  maxSlots: number | null;
}

/** trabajo que el gc conservó en el worktree de una conversación: recuentos por run, nunca paths. */
export interface KeptWorktree {
  runId: number;
  dirtyFiles: number;
  unpushedCommits: number;
}

export interface ServerState {
  // epoch ms del claim que lo dijo.
  at: number;
  baseUrl: string;
  // credencial con la que reclamó (un `login` posterior lo deja viejo).
  clientId: string;
  // null = reclama sin impedimento (sin trabajo en cola); claimed, unpaired o el de la cabecera.
  state: string | null;
  runner: RunnerBlock | null;
  kept: KeptWorktree[] | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

/** el bloque `runner` de una respuesta del claim; null si no lo trae (server anterior a 0.11) o no es válido. */
export function parseRunnerBlock(raw: unknown): RunnerBlock | null {
  if (!isObj(raw) || !isObj(raw.runner)) return null;
  const r = raw.runner;
  const id = intOrNull(r.id);
  if (id === null || id <= 0 || typeof r.paused !== 'boolean' || typeof r.accepts !== 'string') return null;
  return { id, name: typeof r.name === 'string' ? r.name : null, paused: r.paused, accepts: r.accepts, maxSlots: intOrNull(r.maxSlots) };
}

/** fichero del estado del server. */
export function serverStatePath(): string {
  return path.join(runnerHome(), SERVER_STATE_FILE);
}

/** lo guardado, o null si no hay (o ilegible: se dice en el log). */
export function readServerState(): ServerState | null {
  let text: string;
  try {
    text = fs.readFileSync(serverStatePath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const v = JSON.parse(text) as unknown;
    return isObj(v) && typeof v.at === 'number' && typeof v.clientId === 'string' ? (v as unknown as ServerState) : null;
  } catch (err) {
    console.error(`[runner] ${serverStatePath()} ilegible: ${(err as Error).message}`);
    return null;
  }
}

/** escribe el estado (tmp + rename, 0600). */
export function writeServerState(state: ServerState): void {
  const file = serverStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: SERVER_STATE_MODE });
  fs.renameSync(tmp, file);
}

/** borra el estado (logout). */
export function clearServerState(): void {
  fs.rmSync(serverStatePath(), { force: true });
}

/** ¿hay que reescribirlo? cambió algo que `status` imprime, o lo guardado ya tiene SERVER_STATE_TOUCH_MS. */
export function serverStateChanged(before: ServerState | null, next: ServerState): boolean {
  if (!before) return true;
  return JSON.stringify({ ...before, at: 0 }) !== JSON.stringify({ ...next, at: 0 }) || next.at - before.at >= SERVER_STATE_TOUCH_MS;
}
