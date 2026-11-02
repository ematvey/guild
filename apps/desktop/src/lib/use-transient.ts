import { useCallback, useEffect, useRef, useState } from "react";

/** A value that falls back to `idle` `ms` after it is shown ("Copied",
 *  "Saved", an optimistic click). The timer dies with the component. */
export function useTransient<T>(idle: T, ms: number): {
  value: T;
  /** Shows `next`, falling back to idle after `ms`. */
  show: (next: T) => void;
  /** Keeps the shown value; it no longer falls back on its own. */
  hold: () => void;
  /** Back to idle now. */
  clear: () => void;
} {
  const [value, setValue] = useState(idle);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const hold = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const show = useCallback((next: T) => {
    hold();
    setValue(next);
    timer.current = setTimeout(() => {
      timer.current = null;
      setValue(idleRef.current);
    }, ms);
  }, [hold, ms]);
  const clear = useCallback(() => {
    hold();
    setValue(idleRef.current);
  }, [hold]);
  useEffect(() => hold, [hold]);
  return { value, show, hold, clear };
}

/** A flag raised for `ms` ("Copied", "Saved"). */
export function useTransientFlag(ms: number): [boolean, () => void, () => void] {
  const { value, show, clear } = useTransient(false, ms);
  const raise = useCallback(() => show(true), [show]);
  return [value, raise, clear];
}
