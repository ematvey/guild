INSERT INTO server_kv (key, value)
SELECT key || ':' || CASE WHEN value LIKE '%-%' THEN 'develop' ELSE 'stable' END, value
FROM server_kv WHERE key = 'desktop_release_version'
ON CONFLICT (key) DO NOTHING;
DELETE FROM server_kv WHERE key = 'desktop_release_version';
