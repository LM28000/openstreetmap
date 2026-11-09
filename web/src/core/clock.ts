/**
 * Horloge globale de la carte.
 *
 * Toutes les couches lisent l'heure ici et affichent leur état « à l'instant t ».
 * Le temps simulé n'est jamais incrémenté image par image : il est recalculé à la
 * demande à partir d'un point d'ancrage (instant réel ↔ instant simulé) et d'une
 * vitesse. `now()` est donc gratuit, toujours cohérent, et peut être appelé
 * autant de fois qu'on veut pendant une même image.
 */

export interface ClockState {
  readonly playing: boolean;
  /** Secondes simulées par seconde réelle (1 = temps réel). */
  readonly speed: number;
  /** Vrai quand on regarde le présent, en temps réel. */
  readonly live: boolean;
}

/** Écart toléré avec l'heure réelle pour être encore considéré « en direct ». */
const LIVE_TOLERANCE_MS = 2_000;

export class Clock {
  private anchorReal = Date.now();
  private anchorSim = this.anchorReal;
  private state: ClockState = { playing: true, speed: 1, live: true };
  private readonly listeners = new Set<() => void>();

  /** Instant simulé, en millisecondes depuis 1970 (UTC). */
  now(): number {
    if (!this.state.playing) return this.anchorSim;
    return this.anchorSim + (Date.now() - this.anchorReal) * this.state.speed;
  }

  getState = (): ClockState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  play(): void {
    this.update({ playing: true });
  }

  pause(): void {
    this.update({ playing: false });
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    this.update({ speed });
  }

  seek(time: number): void {
    this.update({}, time);
  }

  /** Revient au présent, en temps réel. */
  goLive(): void {
    this.update({ playing: true, speed: 1 }, Date.now());
  }

  private update(patch: Partial<Pick<ClockState, 'playing' | 'speed'>>, time = this.now()): void {
    this.anchorReal = Date.now();
    this.anchorSim = time;
    const playing = patch.playing ?? this.state.playing;
    const speed = patch.speed ?? this.state.speed;
    const live = playing && speed === 1 && Math.abs(time - this.anchorReal) < LIVE_TOLERANCE_MS;
    this.state = { playing, speed, live };
    for (const listener of this.listeners) listener();
  }
}

export const clock = new Clock();
