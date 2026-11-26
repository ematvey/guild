// The theme provider lives in the shared UI kit; re-exported for app code.
export { ThemeProvider, useTheme, applyTheme, resolvedDark, type Theme } from "@guild/ui/theme";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const workPalettes = ["Slate", "Jade", "Ember"] as const;
export const workFonts = ["Inter", "System", "Serif", "Mono"] as const;
type WorkAppearance = {
  palette: (typeof workPalettes)[number];
  font: (typeof workFonts)[number];
};

const appearanceKey = "guild.work.appearance";
const defaults: WorkAppearance = { palette: "Slate", font: "Inter" };
const Appearance = createContext({
  appearance: defaults,
  setAppearance: (_next: Partial<WorkAppearance>) => {},
  resetAppearance: () => {},
});

function readWorkAppearance(): WorkAppearance {
  try {
    const stored = JSON.parse(localStorage.getItem(appearanceKey) ?? "{}");
    return {
      palette: workPalettes.includes(stored?.palette) ? stored.palette : defaults.palette,
      font: workFonts.includes(stored?.font) ? stored.font : defaults.font,
    };
  } catch {
    return defaults;
  }
}

export function WorkAppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, update] = useState(readWorkAppearance);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.workPalette = appearance.palette;
    root.dataset.workFont = appearance.font;
    try {
      localStorage.setItem(appearanceKey, JSON.stringify(appearance));
    } catch {}
    return () => {
      delete root.dataset.workPalette;
      delete root.dataset.workFont;
    };
  }, [appearance]);
  return (
    <Appearance.Provider
      value={{
        appearance,
        setAppearance: (next) => update((current) => ({ ...current, ...next })),
        resetAppearance: () => update(defaults),
      }}
    >
      {children}
    </Appearance.Provider>
  );
}

export const useWorkAppearance = () => useContext(Appearance);
