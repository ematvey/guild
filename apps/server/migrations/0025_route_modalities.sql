-- Native input modalities per model route. Values: image, audio, video.
-- Empty = text-only (default for every pre-existing route). The worker
-- passes image/audio attachment parts to the model ONLY when the resolved
-- route lists the modality; unsupported uploads stay in object storage for
-- later code-execution tooling.
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS modalities TEXT[] NOT NULL DEFAULT '{}';
