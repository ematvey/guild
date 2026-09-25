import { useEffect, useState } from "react";
import { Toaster as Sonner, toast } from "sonner";

import { resolvedDark, useTheme, type Theme } from "../theme";

export { toast };

/// True below 640px (phones): toasts must not sit over the composer.
function useNarrowViewport() {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/// Sonner toaster themed by the Guild theme (dark-first). Mount once at the
/// app root; settings actions call `toast.success` / `toast.error`.
export function Toaster({ theme }: { theme: Theme }) {
  const narrow = useNarrowViewport();
  return (
    <Sonner
      theme={resolvedDark(theme) ? "dark" : "light"}
      position={narrow ? "top-center" : "bottom-right"}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
    />
  );
}

/// Mounts the Toaster inside a ThemeProvider consumer.
export function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} />;
}
