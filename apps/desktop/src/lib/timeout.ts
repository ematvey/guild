// Gives up waiting on a promise after a deadline. The work itself keeps
// running in the background; only the wait ends.

/** Settles with `promise`, or with `onTimeout()` (its value, or the error it
 *  throws) once `ms` passes first. */
export function withTimeout<T, F = never>(promise: Promise<T>, ms: number, onTimeout: () => F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<F>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, ms);
  });
  // The losing side must not surface an unhandled rejection when the race
  // settles the other way, and the timer must not outlive the race.
  deadline.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** `withTimeout` that rejects with `message` at the deadline. */
export function timeoutAfter<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return withTimeout(promise, ms, () => {
    throw new Error(message);
  });
}
