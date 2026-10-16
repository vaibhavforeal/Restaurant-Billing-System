# Owner-controlled restaurant features

Feature controls live at **https://<licensing-service-host>/owner**, a private panel for the ForkFlow owner. Restaurant staff have a read-only availability view in Marketplace. They cannot enable or disable modules through either local feature or integration APIs.

## Owner panel

Sign in using the Worker OWNER_PASSWORD secret. The panel lists registered restaurants by organization/outlet, including counter installation IDs and contact emails. Give each restaurant a display name, search the list, and toggle its modules independently. Multiple installations sharing one organization/outlet receive the same restaurant settings. Feature changes have an audit history and revision checks to prevent overwriting another owner's changes. Billing and recovery remain required; Swiggy remains unavailable. Licence entitlements still apply, so an owner-enabled Pro module is unavailable on Basic.

## Synchronization and offline operation

The restaurant server authenticates POST /v1/features with its installation secret. The service signs the policy with the existing Ed25519 licence key. The counter validates signature, installation, organization, outlet and revision, and stores the signed envelope in SQLite. Older revisions and conflicting same-revision settings are rejected. Online counters check every minute, at startup when activated, and after successful licence renewal checks. Connected staff windows refresh on feature/integration WebSocket events. A network failure preserves the last verified settings.

Before the first policy arrives, existing optional application modules keep their enabled defaults and integrations default off. Prior staff preferences are ignored by commercial deployments. No external call blocks billing. An offline restaurant cannot receive a change until reconnecting; the panel cannot promise immediate remote disabling.

Disabling modules blocks new operations while preserving bill history, existing order completion, exact retry recovery and mounted drafts. Active takeaway orders stay payable. Recipe and stock accounting continue for existing sales. Guest menus refresh availability on focus and every 30 seconds, while submission APIs enforce current settings.

## Deployment

The implementation is local and has not been deployed. Configure the existing licensing Worker and D1 database IDs first, then apply migration 0003_owner_features.sql in the test environment. Set a unique random owner password of at least 16 characters as a Worker secret; use the interactive prompt so it is not written to shell history:

```powershell
npx wrangler@4 secret put OWNER_PASSWORD --env test
npx wrangler@4 d1 migrations apply forkflow-licensing-test --env test --remote
npx wrangler@4 deploy --env test
```

Verify the owner panel and counter sync on the test service. Repeat secret configuration, migration and deployment for production when ready. Keep the existing LICENSE_SIGNING_KEY and installation-secret setup. Update counters to the new build; SQLite migration 33 adds the signed policy cache automatically. Owner settings are separate from paid subscription terms and do not issue or renew licences.

Owner sessions last eight hours and use hashed tokens with HttpOnly, Secure, SameSite=Strict cookies. Mutation requests require the panel's origin. Login is rate limited. Sign out invalidates the session; protect the owner password independently of restaurant PINs. For password rotation, change the Worker secret and clear owner_sessions to revoke existing sessions.

## API

- Owner POST /owner/api/login, POST /owner/api/logout; GET /owner/api/restaurants.
- Owner PATCH /owner/api/restaurants/:organizationId/:outletId updates {name}.
- Owner PATCH /owner/api/restaurants/:organizationId/:outletId/features/:id accepts {enabled,revision}.
- Owner GET /owner/api/restaurants/:organizationId/:outletId returns the latest 100 feature changes.
- Counter POST /v1/features accepts {installationId}, requires X-ForkFlow-Installation-Secret, returns {policy: signedEnvelope}.
- Staff GET /api/features remains available, uncached; PATCH /api/features/:id and PATCH /api/integrations/:id return 403 in normal runtimes.

## Staff permissions

In the owner panel, choose **Manage staff permissions** under a restaurant, select a staff member, and use the View, Add/Create, Update and Delete checkbox columns. Disabled checkboxes represent unsupported actions. Save permissions applies individual overrides; Reset to role defaults removes them. Existing roles are the starting template. Last-admin protection, licences, discount limits, approval PINs and recovery rules remain enforced. Non-admin staff with delegated staff-management access cannot modify administrators or assign roles.

Counters report staff IDs, names, role and active status on the normal minute sync; PINs and PIN hashes stay local. Permissions are scoped to both restaurant and counter installation, signed in the feature policy and retained offline. Every authenticated API permission check re-evaluates the current override. Delete corresponds to existing archive/deactivate/cancel actions; no destructive accounting deletion was added. Bulk catalog import requires the relevant create/update permissions together. Staff navigation reflects access; the API remains authoritative.

Apply Worker D1 migration **0004_staff_permissions.sql** with the normal migration command before deploying this update, then update restaurant builds. Local sample staff are demonstration records; localhost data resets on restart.
