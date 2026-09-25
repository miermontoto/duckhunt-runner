// exclusión mutua async por clave (fifo), para los runs en paralelo: el daemon serializa con ella
// las operaciones git sobre un mismo checkout (fetch, worktree add/remove/prune, gc) y los runs que
// comparten un cwd no aislado. solo coordina ESTE proceso: dos daemons sobre la misma máquina no
// se ven entre sí.

export class KeyedMutex {
  // cola de cada clave: se resuelve cuando el último en entrar libera. sin entrada = libre.
  private readonly tails = new Map<string, Promise<void>>();

  /** espera el turno de `key` y devuelve la función que lo libera (idempotente). */
  acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => held);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return prev.then(() => release);
  }

  /** true si alguien tiene o espera el turno de `key`. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }

  /** ejecuta `fn` con el turno de `key` y lo libera al terminar, falle o no. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
