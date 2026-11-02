import { useEffect, useState } from "react";

/** `value`, once it has held still for `delayMs`. The first render takes it
 *  as is, so a deep link fetches at once. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, settled, delayMs]);
  return settled;
}
