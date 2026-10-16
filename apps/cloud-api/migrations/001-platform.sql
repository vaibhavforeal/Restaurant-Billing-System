-- Run once using a migration principal. The web runtime MUST use forkflow_cloud.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forkflow_cloud') THEN
    CREATE ROLE forkflow_cloud NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS cloud_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS accounts (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text,
 platform_role text NOT NULL DEFAULT 'owner' CHECK(platform_role IN ('owner','platform_admin')),
 disabled boolean NOT NULL DEFAULT false, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS organizations(id uuid PRIMARY KEY, name text NOT NULL, created_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (
 organization_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL REFERENCES accounts(id),
 role text NOT NULL CHECK(role IN ('owner','manager','viewer')), PRIMARY KEY(organization_id, account_id)
);
CREATE TABLE IF NOT EXISTS account_tokens (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), kind text NOT NULL CHECK(kind IN ('invite','reset')),
 expires_at bigint NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS web_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), csrf_hash text NOT NULL,
 expires_at bigint NOT NULL, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS web_sessions_account ON web_sessions(account_id);
-- These authentication lookup tables contain hashes and scope identifiers only, never business records.
CREATE TABLE IF NOT EXISTS installation_credentials (
 credential_hash text PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), outlet_id uuid NOT NULL,
 installation_id uuid NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS pairing_codes (
 code_hash text PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), outlet_id uuid NOT NULL,
 expires_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS outlets (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL,
 installation_id uuid, epoch uuid, acknowledged_sequence bigint NOT NULL DEFAULT 0 CHECK(acknowledged_sequence >= 0),
 bootstrapped boolean NOT NULL DEFAULT false, bootstrap_hash text, last_seen_at bigint, created_at bigint NOT NULL,
 UNIQUE(organization_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_outlet_per_installation ON outlets(installation_id) WHERE installation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sync_journal (
 organization_id uuid NOT NULL, outlet_id uuid NOT NULL, epoch uuid NOT NULL, sequence bigint NOT NULL,
 event_id uuid NOT NULL, digest text NOT NULL, envelope jsonb NOT NULL, received_at bigint NOT NULL,
 PRIMARY KEY(outlet_id,epoch,sequence), UNIQUE(outlet_id,event_id),
 FOREIGN KEY(organization_id,outlet_id) REFERENCES outlets(organization_id,id)
);
CREATE TABLE IF NOT EXISTS projections (
 organization_id uuid NOT NULL, outlet_id uuid NOT NULL, entity_table text NOT NULL, entity_key jsonb NOT NULL,
 row_data jsonb NOT NULL, revision bigint NOT NULL CHECK(revision>=0),
 PRIMARY KEY(outlet_id,entity_table,entity_key), FOREIGN KEY(organization_id,outlet_id) REFERENCES outlets(organization_id,id)
);
CREATE TABLE IF NOT EXISTS management_commands (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, outlet_id uuid NOT NULL, kind text NOT NULL, target_id text,
 expected_revision bigint NOT NULL CHECK(expected_revision>=0), payload jsonb NOT NULL, requested_by uuid NOT NULL REFERENCES accounts(id),
 created_at bigint NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','conflict','rejected','cancelled')),
 revision bigint, error text, completed_at bigint,
 FOREIGN KEY(organization_id,outlet_id) REFERENCES outlets(organization_id,id)
);
CREATE INDEX IF NOT EXISTS commands_pending ON management_commands(outlet_id,created_at) WHERE status='pending';
CREATE TABLE IF NOT EXISTS subscriptions (
 organization_id uuid NOT NULL, outlet_id uuid PRIMARY KEY, state jsonb NOT NULL, updated_at bigint NOT NULL,
 FOREIGN KEY(organization_id,outlet_id) REFERENCES outlets(organization_id,id)
);
CREATE TABLE IF NOT EXISTS audit_log (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), actor_id uuid REFERENCES accounts(id),
 action text NOT NULL, target_id text, details jsonb NOT NULL DEFAULT '{}', created_at bigint NOT NULL
);
CREATE OR REPLACE FUNCTION cloud_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only journal'; END $$;
DROP TRIGGER IF EXISTS journal_immutable ON sync_journal;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON sync_journal FOR EACH ROW EXECUTE FUNCTION cloud_immutable();
DROP TRIGGER IF EXISTS audit_immutable ON audit_log;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION cloud_immutable();
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['outlets','sync_journal','projections','management_commands','subscriptions','audit_log'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I',tbl);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',tbl);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO forkflow_cloud;
GRANT SELECT,INSERT,UPDATE,DELETE ON accounts,organizations,memberships,account_tokens,web_sessions,installation_credentials,pairing_codes,outlets,projections,management_commands,subscriptions TO forkflow_cloud;
GRANT SELECT,INSERT ON sync_journal,audit_log TO forkflow_cloud;
REVOKE UPDATE,DELETE,TRUNCATE ON sync_journal,audit_log FROM forkflow_cloud;
INSERT INTO cloud_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
COMMIT;
