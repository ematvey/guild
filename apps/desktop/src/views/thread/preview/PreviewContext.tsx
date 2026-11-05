// Opening a file in the thread's preview pane, from anywhere in the thread:
// an attachment chip, an artifact card. A context keeps the plumbing out of
// every block component.
import { createContext, useContext } from "react";
import type { PreviewRef } from "../route";
import type { PreviewMeta } from "./use-preview-source";

export type OpenPreview = (ref: PreviewRef, meta?: PreviewMeta) => void;

const PreviewContext = createContext<OpenPreview | null>(null);

export const PreviewProvider = PreviewContext.Provider;

/** Opens a file in the preview pane; a no-op outside a thread view. */
export function usePreview(): OpenPreview {
  return useContext(PreviewContext) ?? (() => {});
}
