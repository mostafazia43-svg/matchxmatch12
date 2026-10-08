/**
 * Time helpers.
 *
 * Gameplay timing uses a monotonic clock, never `Date.now()`: NTP corrections
 * and clock drift would otherwise show up as impossible reaction times and
 * false cheat flags. Wall-clock time is used only for persistence.
 */

const originWall = Date.now();
const originMono = Number(process.hrtime.bigint() / 1_000_000n);

/** Monotonic milliseconds. Never jumps backwards. */
export function monoNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Convert a monotonic timestamp to wall-clock for storage. */
export function monoToDate(mono: number): Date {
  return new Date(originWall + (mono - originMono));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const ms = {
  seconds: (n: number) => n * 1000,
  minutes: (n: number) => n * 60_000,
  hours: (n: number) => n * 3_600_000,
};

export function sleep(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

/** setTimeout that survives being cleared twice and returns a canceller. */
export function schedule(fn: () => void, delayMs: number): () => void {
  const handle = setTimeout(fn, Math.max(0, delayMs));
  let cleared = false;
  return () => {
    if (cleared) return;
    cleared = true;
    clearTimeout(handle);
  };
}
