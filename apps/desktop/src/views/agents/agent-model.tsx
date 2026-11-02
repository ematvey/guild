import { useEffect, useSyncExternalStore } from "react";
import { listModels, modelLabel, type ModelOption } from "../../lib/api/models";
import { modelsSnapshot, seedModelList, subscribeModels } from "../../lib/models-store";
import { cacheEpochChanged, currentCacheEpoch } from "../settings/use-cached-api";

/** One HTTP seed per empty store: the member socket pushes the list on
 *  connect, so the read only covers a mount that lands before that frame.
 *  A failed read is not remembered; the next mount retries. */
let seeding: Promise<void> | null = null;

function seedModels(): void {
  if (seeding !== null || modelsSnapshot() !== null) return;
  const epoch = currentCacheEpoch();
  seeding = listModels().then((rows) => {
    seeding = null;
    // A read that outlived its session seeds nothing.
    if (rows !== null && !cacheEpochChanged(epoch)) seedModelList(rows);
  });
}

/** The org's enabled models; null while none has arrived. Model ids are
 *  provider names; the app shows the admin's alias (e.g. "Auto"). The list
 *  is the socket's `model_list` push, so an admin's route change repaints
 *  every picker live. `enabled = false` reads the store without seeding
 *  it. */
export function useModelOptions(enabled = true): ModelOption[] | null {
  const models = useSyncExternalStore(subscribeModels, modelsSnapshot, modelsSnapshot);
  useEffect(() => {
    if (enabled && models === null) seedModels();
  }, [enabled, models]);
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

/** The model's display name. `alias` comes with the agent payload, so the
 *  label is correct on first paint; the fetched list is the fallback for
 *  callers that have only an id. */
export function ModelName({
  id,
  alias,
  className,
}: {
  id: string;
  alias?: string | null;
  className?: string;
}) {
  const hasAlias = alias !== undefined && alias !== null && alias !== "";
  // The payload carries the label: no catalog request on that path.
  const models = useModelOptions(!hasAlias);
  if (hasAlias) {
    return <span className={className}>{alias}</span>;
  }
  return <span className={className}>{agentModelLabel(id, models)}</span>;
}
