-- The wipe migration (0048) ran before the stuck-generation invocation
-- records were added to its kv cleanup list; stale chatgen_inv:% rows
-- retry a kill against wiped Restate state on every boot. Clear them.
DELETE FROM server_kv WHERE key LIKE 'chatgen_inv:%';
