// slots de la máquina repartidos entre plataformas (t#495, M6.2): un pool global (defaults.maxConcurrent, el cómputo
// es la máquina del usuario) y la cuota de cada plataforma. una plataforma solo reclama con un slot ya reservado
// (hueco en el pool Y en su cuota): nunca se reclama un run sin sitio donde correrlo. la reserva pasa a ser la del
// run si el claim trae uno, y se devuelve si no (sin trabajo, sin respuesta) o cuando el run termina.
// con una sola plataforma con todo el pool como cuota es la regla de siempre: reclamar solo con un slot libre.
// reparto justo (t#495, M6.5): un slot que se libera se OFRECE a la siguiente plataforma en round-robin (orden de
// alta) de las que esperan uno y están bajo su cuota, y se le guarda hasta que lo reserve o caduque la oferta
// (offerTtlMs): mientras, nadie más se lo lleva. si esa plataforma no tiene trabajo, devuelve la reserva y el slot
// se ofrece a la siguiente en el acto. con Σ cuotas ≤ pool nadie espera por otra (una oferta solo va a quien está
// bajo su cuota); con más cuota que pool, cada plataforma que espera recibe un slot por vuelta.

/** caducidad por defecto de una oferta: lo que tarda un poll en volver a mirar. */
export const OFFER_TTL_MS = 5_000;

/** una plataforma que espera slot y su cuota. */
export interface Waiting {
  id: string;
  quota: number;
}

export class Scheduler {
  // reservas por plataforma: runs en vuelo más el claim en curso.
  private readonly inFlight = new Map<string, number>();
  // slots ofrecidos y guardados para una plataforma (con cuándo se ofrecieron).
  private readonly offers = new Map<string, number>();
  // la última plataforma a la que se le ofreció un slot: la vuelta sigue desde la siguiente.
  private cursor: string | null = null;

  constructor(
    private readonly pool: () => number,
    private readonly offerTtlMs = OFFER_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** slots reservados: de una plataforma o, sin id, de todas. */
  used(id?: string): number {
    return id === undefined ? [...this.inFlight.values()].reduce((n, v) => n + v, 0) : (this.inFlight.get(id) ?? 0);
  }

  // ofertas vivas (las caducadas se olvidan) para plataformas que no son `id`.
  private offeredToOthers(id?: string): number {
    const now = this.now();
    [...this.offers].filter(([, at]) => now - at >= this.offerTtlMs).forEach(([offered]) => this.offers.delete(offered));
    return [...this.offers.keys()].filter((offered) => offered !== id).length;
  }

  /** reserva un slot para un claim de `id` si queda hueco en el pool (sin contar los ofrecidos a otras) y en su cuota. */
  tryReserve(id: string, quota: number): boolean {
    if (this.used() + this.offeredToOthers(id) >= this.pool() || this.used(id) >= quota) return false;
    this.offers.delete(id);
    this.inFlight.set(id, this.used(id) + 1);
    return true;
  }

  /** devuelve una reserva de `id` (el claim no trajo run, o el run terminó). */
  release(id: string): void {
    const left = this.used(id) - 1;
    if (left > 0) this.inFlight.set(id, left);
    else this.inFlight.delete(id);
  }

  /** retira la oferta de `id` (ya no reclama: en pausa, retirada). */
  withdraw(id: string): void {
    this.offers.delete(id);
  }

  /**
   * ofrece un slot libre a la siguiente plataforma en round-robin: `order` son todas por orden de alta y `waiting` las
   * que esperan slot. salta a las que están en su cuota o ya tienen uno ofrecido. devuelve a cuál, o null si no
   * queda slot libre o nadie lo puede usar.
   */
  offer(order: readonly string[], waiting: readonly Waiting[]): string | null {
    if (this.used() + this.offeredToOthers() >= this.pool()) return null;
    const quotas = new Map(waiting.map((w) => [w.id, w.quota]));
    const start = this.cursor === null ? 0 : order.indexOf(this.cursor) + 1;
    const next = [...order.slice(start), ...order.slice(0, start)].find((id) => quotas.has(id) && !this.offers.has(id) && this.used(id) < quotas.get(id)!);
    if (next === undefined) return null;
    this.offers.set(next, this.now());
    this.cursor = next;
    return next;
  }
}
