BEGIN;
-- The runtime checks the exact deployed schema before accepting traffic.
GRANT SELECT ON cloud_migrations TO forkflow_cloud;
INSERT INTO cloud_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
COMMIT;
