BEGIN;
CREATE TABLE IF NOT EXISTS storage_objects (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, outlet_id uuid NOT NULL, installation_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('backup','media')), sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 bytes bigint NOT NULL CHECK(bytes>0), metadata jsonb NOT NULL, staging_key text NOT NULL UNIQUE, object_key text NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','expired','deleted')),
 created_at bigint NOT NULL, expires_at bigint NOT NULL, completed_at bigint,
 FOREIGN KEY(organization_id,outlet_id) REFERENCES outlets(organization_id,id)
);
CREATE INDEX IF NOT EXISTS storage_backup_history ON storage_objects(outlet_id,completed_at DESC) WHERE kind='backup' AND state='complete';
ALTER TABLE storage_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON storage_objects;
CREATE POLICY tenant_scope ON storage_objects USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON storage_objects TO forkflow_cloud;
INSERT INTO cloud_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
COMMIT;
