// estado de un run en vuelo en el daemon: desde el claim hasta el status. el latido vive a esta
// altura (no en el proceso de claude) porque con runs en paralelo un run puede esperar turno en un
// lock antes de lanzar claude, y sin latido el sweeper del server lo daría por lost a los 3 min.
// `kill` es el único camino para parar un run: cancel del server, parada del daemon. si llega
// antes de lanzar claude, el run no lo lanza; si llega durante, mata su grupo de procesos.

import type { ChildProcess } from 'node:child_process';
import type { KillReason } from './status-report.js';

/** señal a todo el grupo de procesos del hijo (spawn detached → pgid = pid del hijo). */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    // ESRCH: el grupo ya no existe. cualquier otro fallo: al menos al hijo directo.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
  }
}

export class RunLease {
  // motivo con el que el run dejó de ser de este proceso (null = sigue siendo suyo).
  killedBy: KillReason | null = null;
  // se resuelve con el primer kill: corta la espera de un lock.
  readonly killed: Promise<KillReason>;
  private resolveKilled!: (reason: KillReason) => void;
  // claude en curso y su kill (null antes de lanzarlo y entre intentos).
  private child: ChildProcess | null = null;
  private killChild: ((reason: KillReason) => void) | null = null;

  constructor(readonly runId: number) {
    this.killed = new Promise((resolve) => (this.resolveKilled = resolve));
  }

  /** el run deja de ser de este proceso; mata el claude en curso si lo hay. solo cuenta el primero. */
  kill(reason: KillReason): void {
    if (this.killedBy) return;
    this.killedBy = reason;
    this.resolveKilled(reason);
    this.killChild?.(reason);
  }

  /** registra el claude recién lanzado; si el run ya estaba muerto, lo mata en el acto. */
  attach(child: ChildProcess, killChild: (reason: KillReason) => void): void {
    this.child = child;
    this.killChild = killChild;
    if (this.killedBy) killChild(this.killedBy);
  }

  detach(): void {
    this.child = null;
    this.killChild = null;
  }

  /** salida forzada del daemon: SIGKILL al grupo del claude en curso. */
  forceKill(): void {
    if (this.child) signalGroup(this.child, 'SIGKILL');
  }
}
