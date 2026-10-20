// slots de la máquina repartidos entre plataformas (t#495, M6.2): un pool global (defaults.maxConcurrent, el cómputo
// es la máquina del usuario) y la cuota de cada plataforma. una plataforma solo reclama con un slot ya reservado
// (hueco en el pool Y en su cuota): nunca se reclama un run sin sitio donde correrlo. la reserva pasa a ser la del
// run si el claim trae uno, y se devuelve si no (sin trabajo, sin respuesta) o cuando el run termina.
// con una sola plataforma con todo el pool como cuota es la regla de siempre: reclamar solo con un slot libre.

export class Scheduler {
  // reservas por plataforma: runs en vuelo más el claim en curso.
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly pool: () => number) {}

  /** slots reservados: de una plataforma o, sin id, de todas. */
  used(id?: string): number {
    return id === undefined ? [...this.inFlight.values()].reduce((n, v) => n + v, 0) : (this.inFlight.get(id) ?? 0);
  }

  /** reserva un slot para un claim de `id` si queda hueco en el pool y en su cuota. */
  tryReserve(id: string, quota: number): boolean {
    if (this.used() >= this.pool() || this.used(id) >= quota) return false;
    this.inFlight.set(id, this.used(id) + 1);
    return true;
  }

  /** devuelve una reserva de `id` (el claim no trajo run, o el run terminó). */
  release(id: string): void {
    const left = this.used(id) - 1;
    if (left > 0) this.inFlight.set(id, left);
    else this.inFlight.delete(id);
  }
}
