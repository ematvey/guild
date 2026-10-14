-- Monthly spend cap per model route (spec §4.2/§4.5). NULL = unlimited.
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS quota_monthly_usd DOUBLE PRECISION;
