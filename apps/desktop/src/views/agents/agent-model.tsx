import { useEffect, useState } from "react";
import { listModels, modelLabel, type ModelOption } from "../../transport";

/** The org's enabled models, fetched once per session. Model ids are
 *  provider names; the app shows the admin's alias (e.g. "Auto") instead. */
let cached: ModelOption[] | null = null;
let inflight: Promise<ModelOption[]> | null = null;

function loadModels(): Promise<ModelOption[]> {
  inflight ??= listModels().then((rows) => {
    cached = rows ?? [];
    return cached;
  });
  return inflight;
}

export function useModelOptions(): ModelOption[] | null {
  const [models, setModels] = useState<ModelOption[] | null>(cached);
  useEffect(() => {
    if (cached !== null) {
      setModels(cached);
      return;
    }
    let live = true;
    void loadModels().then((rows) => {
      if (live) setModels(rows);
    });
    return () => {
      live = false;
    };
  }, []);
  return models;
}

/** Display name for a stored model id: the app alias when one exists,
 *  otherwise the id. A blank while the model list loads, so a raw provider
 *  id never flashes on screen. */
export function agentModelLabel(id: string, models: ModelOption[] | null): string {
  if (id === "") return "";
  if (models === null) return "…";
  const option = models.find((m) => m.id === id);
  return option === undefined ? id : modelLabel(option);
}

export function ModelName({ id, className }: { id: string; className?: string }) {
  const models = useModelOptions();
  return <span className={className}>{agentModelLabel(id, models)}</span>;
}
