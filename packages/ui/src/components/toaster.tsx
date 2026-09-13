import { Toaster as Sonner, toast } from "sonner";

import { resolvedDark, useTheme, type Theme } from "../theme";

export { toast };

/// Sonner toaster themed by the Guild theme (dark-first). Mount once at the
/// app root; settings actions call `toast.success` / `toast.error`.
export function Toaster({ theme }: { theme: Theme }) {
  return (
    <Sonner
      theme={resolvedDark(theme) ? "dark" : "light"}
      position="bottom-right"
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
