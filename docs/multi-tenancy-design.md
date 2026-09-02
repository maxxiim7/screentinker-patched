# ScreenTinker Multi-Tenancy / Reseller Design (V1)

Status: design approved 2026-05-11. Implementation begins Phase 1 on approval of this doc.

## 1. Mental model

Today every user is the root of their own data. Teams give shared scope inside one user. There is no layer above that.

V1 adds two layers:

```
platform                 (the hosted screentinker.com instance, or one self-hosted install)
  organization           (a reseller or a customer paying us; owns a Stripe sub)
    workspace            (a client of the reseller; what was previously a Team)
      device | content | playlist | layout | widget | schedule | video_wall | ...
```

- An **organization** is a billing/admin entity. Resellers run an org with many workspaces. Direct customers run an org with one workspace.
- A **workspace** is a tenant. Data inside is isolated from siblings. Equivalent to today's `teams` row, just parented by an org.
- Workspaces are the unit of UI tenancy: when you log in, you are "in" exactly one workspace at a time. The workspace picker switches context.

`teams` collapses into `workspaces`. `team_members` collapses into `workspace_members`. No nested teams inside workspaces in V1.

## 2. Roles

| Role | Scope | Powers |
| --- | --- | --- |
| `platform_admin` | platform (one or two rows) | sees everything across all orgs. Replaces today's `superadmin`. Hosted operator only. |
| `org_owner` | one org | full control of the org and every workspace inside, owns the Stripe subscription, can delete the org. |
| `org_admin` | one org | same as `org_owner` minus billing and delete-org. Suitable for reseller staff. |
| `workspace_admin` | one workspace | full control of one workspace: users, devices, content, playlists, branding. |
| `workspace_editor` | one workspace | create/edit content, devices, playlists, layouts, schedules. No user invites, no branding. |
| `workspace_viewer` | one workspace | read-only. |

Notes:
- Today's `users.role = 'admin'` (intermediate hosted role) is dropped. Existing rows get migrated to `org_admin` of their migrated org. See section 7.
- `workspace_owner` and `workspace_admin` collapse into a single `workspace_admin` role.
- A single user can hold roles in multiple orgs and multiple workspaces (multi-org membership). Memberships are stored in two join tables (see section 3).

### Permission check layering

Resolution order on every request, top wins:

1. `platform_admin` on the user row -> allow.
2. `org_owner` or `org_admin` on the user-in-this-org membership -> allow within that org's workspaces.
3. `workspace_admin` / `editor` / `viewer` on the user-in-this-workspace membership -> allow within that one workspace at the role level.
4. Otherwise -> 403.

Code shape (pseudocode, not code):

```
function can(user, action, target) {
  if (user.role === 'platform_admin') return true;
  const orgRole = orgRoleOf(user.id, target.organization_id);
  if (orgRole === 'org_owner') return true;
  if (orgRole === 'org_admin' && !ORG_OWNER_ONLY.has(action)) return true;
  const wsRole = workspaceRoleOf(user.id, target.workspace_id);
  return roleAllows(wsRole, action);
}
```

`ORG_OWNER_ONLY = { 'billing.write', 'org.delete', 'workspace.delete' }`.

## 3. Schema

### 3.1 New tables

```sql
CREATE TABLE IF NOT EXISTS organizations (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    slug                    TEXT UNIQUE,                       -- v2 subdomain hook
    owner_user_id           TEXT NOT NULL REFERENCES users(id),
    plan_id                 TEXT DEFAULT 'free' REFERENCES plans(id),
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT,
    subscription_status     TEXT DEFAULT 'active',
    subscription_ends       INTEGER,
    -- subscription lifecycle (section 8)
    grace_period_ends       INTEGER,                           -- nullable; set when sub fails or cancels at period end
    locked_at               INTEGER,                           -- nullable; set when grace expires
    -- branding defaults applied to new workspaces in this org
    default_brand_name      TEXT,
    default_logo_url        TEXT,
    default_primary_color   TEXT,
    created_at              INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at              INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS organization_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'org_admin',        -- 'org_owner' | 'org_admin'
    invited_by      TEXT REFERENCES users(id),
    joined_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    slug            TEXT,                                       -- v2 subdomain hook; unique within org
    created_by      TEXT REFERENCES users(id),
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(organization_id, slug)
);

CREATE TABLE IF NOT EXISTS workspace_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'workspace_viewer',  -- 'workspace_admin' | 'workspace_editor' | 'workspace_viewer'
    invited_by      TEXT REFERENCES users(id),
    joined_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_invites (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'workspace_viewer',
    invited_by      TEXT NOT NULL REFERENCES users(id),
    expires_at      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

### 3.2 Existing-table changes

Every per-tenant resource gets a `workspace_id`. The legacy `user_id` column stays (nullable) and represents "created by"; the legacy `team_id` column stays for one release as a compatibility shim, then drops in V2.

| Table | Adds | Notes |
| --- | --- | --- |
| `devices` | `workspace_id TEXT REFERENCES workspaces(id)` | required for new rows; legacy `user_id` becomes nullable created_by. |
| `content` | `workspace_id` | same. |
| `playlists` | `workspace_id` | same. |
| `layouts` | `workspace_id` | same. |
| `widgets` | `workspace_id` | same. `user_id IS NULL` ("public") rows stay platform-level templates owned by `platform_admin`. |
| `schedules` | `workspace_id` | same. |
| `video_walls` | `workspace_id` | same. |
| `device_groups` | `workspace_id` | same. |
| `white_labels` | `workspace_id TEXT REFERENCES workspaces(id)` (keyed by workspace, not user). | Org-level defaults live on `organizations.default_*`. |
| `activity_log` | `organization_id`, `workspace_id`, `acting_user_id`, `was_acting_as` | both org and workspace since some actions are org-scoped (billing). `acting_user_id` records the reseller when an action was performed via acting-as; `was_acting_as INTEGER DEFAULT 0` is the boolean flag. When not acting-as, `acting_user_id` is NULL and `was_acting_as = 0`. |
| `kiosk_pages` | `workspace_id` | same. |
| `alert_configs` | `workspace_id` | same. |
| `device_fingerprints` | (none) | platform-wide reinstall guard, stays user-keyed by intent. |

### 3.3 Stripe columns

`users.plan_id`, `users.stripe_customer_id`, `users.stripe_subscription_id`, `users.subscription_status`, `users.subscription_ends` -> move to `organizations`. Columns stay on `users` as nullable for one release (see Q9 default), then drop in V2.

### 3.3.1 Workspace billing metadata (add D)

The `workspaces` table also carries reseller-side annotation columns. These are visible and editable only to `org_owner` and `org_admin`. `workspace_admin` and below cannot see them. They never affect Stripe, never affect device caps, and ScreenTinker never emails the addresses stored in them.

```sql
ALTER TABLE workspaces ADD COLUMN billing_type          TEXT DEFAULT 'client_billable';
ALTER TABLE workspaces ADD COLUMN billing_notes         TEXT;
ALTER TABLE workspaces ADD COLUMN billing_contact_email TEXT;
ALTER TABLE workspaces ADD COLUMN billing_contract_ref  TEXT;
```

| Column | Purpose |
| --- | --- |
| `billing_type` | One of `client_billable` (default - workspace is a paying client of the reseller), `client_complimentary` (client the reseller is comping - demo, charity, freebie), `internal` (the reseller's own usage - test bed, sales demo, their own signage). |
| `billing_notes` | Free-text reseller memory of the deal: "Acme - $50/mo, net-30, started 2025-09-01". |
| `billing_contact_email` | Whom at the client the reseller invoices. Stored only; never receives platform email. |
| `billing_contract_ref` | Reseller's internal cross-reference (contract id, CRM ticket, whatever). |

How a reseller actually charges these clients (full retail, discounted, comped, not at all) is the reseller's business and never modeled or enforced by the platform. See §8.1.

### 3.4 What stays user-scoped

- `users` table itself: identity, password, auth_provider, name, avatar.
- `device_fingerprints`: reinstall guard, no tenancy concept.
- `team_invites` / `workspace_invites`: scoped to the inviting workspace.

### 3.5 What gets both org and workspace IDs

Only `activity_log`. Some entries (billing, workspace create/delete) need to live at the org level even if no workspace context applies; others (device pair, content upload) carry both for filtering.

## 4. Migration

### 4.1 Strategy

Every existing user with any owned data becomes an `organizations` row plus a default `workspaces` row plus optional additional workspaces (their existing teams).

```
For each user U with owned data:
  org_id = new uuid
  insert organizations(id=org_id, name="<U.email>'s organization",
                       owner_user_id=U.id,
                       plan_id=U.plan_id,
                       stripe_*=U.stripe_*,
                       subscription_*=U.subscription_*)
  insert organization_members(org_id, U.id, role='org_owner')

  if U owns any teams T1..Tn:
    for each Ti:
      insert workspaces(id=Ti.id, organization_id=org_id, name=Ti.name, created_by=Ti.owner_id)
      -- workspace.id reuses team.id so referencing rows continue to resolve
      for each team_members row M of Ti:
        ws_role = map(M.role)   -- owner -> workspace_admin, editor -> workspace_editor, viewer -> workspace_viewer
        insert workspace_members(workspace_id=Ti.id, user_id=M.user_id, role=ws_role)
    -- pick a default workspace for U: the team they own with the most data (or first by created_at)

  else:
    ws_id = new uuid
    insert workspaces(id=ws_id, organization_id=org_id, name='Default', created_by=U.id)
    insert workspace_members(workspace_id=ws_id, user_id=U.id, role='workspace_admin')

  for each user-scoped table (devices, content, etc):
    UPDATE table SET workspace_id = (
      -- if team_id is set on the row, use it as the workspace_id (team and workspace share id)
      -- otherwise use U's default workspace
      COALESCE(table.team_id, U_default_ws_id)
    )
    WHERE user_id = U.id

For each user U with users.role IN ('superadmin'):
  UPDATE users SET role='platform_admin' WHERE id=U.id

For each user U with users.role = 'admin':
  -- legacy intermediate role is dropped. Their migrated org gets them as org_admin.
  -- if they already became org_owner via the loop above, leave as org_owner.
  UPDATE users SET role='user' WHERE id=U.id
  -- (org_admin row is added by the per-org loop above for any team-membered admins)
```

Re-using `team.id` as the new `workspace.id` is intentional: every existing FK that points at a team continues to resolve without rewriting. Sockets, JWTs, and bookmarked URLs survive.

### 4.2 Migration SQL (high level)

Lives in `server/db/database.js` migrations array, idempotent, runs on next boot:

```sql
-- New tables (4x CREATE TABLE IF NOT EXISTS, shown in 3.1).

-- Additive columns. Each wrapped in try/catch in the migration runner so re-runs are safe.
ALTER TABLE devices         ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE content         ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE playlists       ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE layouts         ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE widgets         ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE schedules       ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE video_walls     ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE device_groups   ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE white_labels    ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE kiosk_pages     ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE alert_configs   ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE activity_log    ADD COLUMN workspace_id     TEXT REFERENCES workspaces(id);
ALTER TABLE activity_log    ADD COLUMN organization_id  TEXT REFERENCES organizations(id);
ALTER TABLE activity_log    ADD COLUMN acting_user_id   TEXT REFERENCES users(id);
ALTER TABLE activity_log    ADD COLUMN was_acting_as    INTEGER DEFAULT 0;

-- Reseller-side workspace annotations (add D).
ALTER TABLE workspaces      ADD COLUMN billing_type          TEXT DEFAULT 'client_billable';
ALTER TABLE workspaces      ADD COLUMN billing_notes         TEXT;
ALTER TABLE workspaces      ADD COLUMN billing_contact_email TEXT;
ALTER TABLE workspaces      ADD COLUMN billing_contract_ref  TEXT;

-- Indexes for the new lookup paths.
CREATE INDEX IF NOT EXISTS idx_devices_workspace        ON devices(workspace_id);
CREATE INDEX IF NOT EXISTS idx_content_workspace        ON content(workspace_id);
CREATE INDEX IF NOT EXISTS idx_playlists_workspace      ON playlists(workspace_id);
CREATE INDEX IF NOT EXISTS idx_video_walls_workspace    ON video_walls(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_organization  ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user   ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members(user_id);
```

Backfill runs as a one-shot in a transaction inside the migration runner, behind a `schema_migrations` row keyed `2026-05-11-multitenancy-backfill` so it only runs once. Pseudocode in 4.1; concrete script ships in Phase 1.

### 4.3 Down-migration

We do NOT auto-rollback. On failure during Phase 1 testing:

1. Take a pre-migration backup (the migration runner snapshots the SQLite file to `data/screentinker.pre-multitenancy.sqlite` before applying anything).
2. Manual rollback: `cp data/screentinker.pre-multitenancy.sqlite data/screentinker.sqlite && systemctl restart`.
3. No partial-migration state is allowed: the backfill runs inside `BEGIN TRANSACTION ... COMMIT`. Any error rolls the whole batch.

Phase 1 ships with a `node scripts/rollback-multitenancy.js` that drops the new tables and ALTER columns for completeness. It is NEVER auto-invoked.

### 4.4 Validation gate

Before Phase 2 begins, Phase 1 must produce a passing local test:

- Clone the production SQLite backup to dev.
- Run migrations.
- For every user U, run a diff:
  - count(devices WHERE user_id=U) before == count(devices WHERE workspace_id IN ws_of_U) after.
  - same for content, playlists, layouts, widgets, schedules, video_walls.
- Existing JWTs still resolve to a valid current_workspace_id.
- Existing API calls still return the same shape (Phase 2 changes the shape; Phase 1 only adds columns).

## 5. API surface

### 5.1 New endpoints

```
POST   /api/orgs                                       create org (platform_admin or self-host bootstrap)
GET    /api/orgs                                       list orgs the caller can see
GET    /api/orgs/:id                                   org detail (incl. workspaces, members, billing summary)
PUT    /api/orgs/:id                                   update org (name, branding defaults)
DELETE /api/orgs/:id                                   delete org (org_owner only)
GET    /api/orgs/:id/usage                             rollup: per-workspace device counts (add B)
POST   /api/orgs/:id/members                           invite org member (org_owner)
DELETE /api/orgs/:id/members/:user_id                  remove org member

POST   /api/orgs/:id/workspaces                        create workspace
GET    /api/workspaces                                 list workspaces the caller can access
GET    /api/workspaces/:id                             workspace detail
PUT    /api/workspaces/:id                             update (name, branding override)
DELETE /api/workspaces/:id                             delete (org_owner)
POST   /api/workspaces/:id/members                     invite member to a workspace
DELETE /api/workspaces/:id/members/:user_id            remove member

POST   /api/auth/switch-workspace                      session swap: { workspace_id } -> new JWT
GET    /api/auth/me                                    now returns { user, current_workspace, accessible_workspaces[], current_org_role }
```

### 5.2 Existing endpoints

V1 keeps every existing path operational. Scoping happens implicitly:

- JWT carries `current_workspace_id`. Set on login (last-used or first available). Updated on `/api/auth/switch-workspace`.
- Every existing route resolves `workspace_id` from JWT and filters by it instead of `user_id`.
- Optional `?workspace_id=` query param overrides per-request (used by org_owner tooling).
- No 308 redirects in V1. Path-versioned `/api/workspaces/:wid/...` form is deferred to V2.

The result is that frontend code in V1 continues to call `/api/devices`, `/api/content`, etc., unchanged. The middleware does the work.

### 5.3 Auth flow

```
POST /api/auth/login -> { token, user, accessible_workspaces[], current_workspace_id }
```

If `accessible_workspaces.length === 1`, frontend auto-enters it.
If `accessible_workspaces.length > 1`, frontend shows the picker.
If `accessible_workspaces.length === 0`, account is dormant (org but no workspace memberships) -> show "No workspace yet" landing.

## 6. Workspace switching UX

- **Picker** at `#/select-workspace` shown after login when count > 1. Two columns:
  - "My workspaces" (workspaces where user is a member).
  - "Acting as" (for org_owner / org_admin: every workspace inside their org they aren't a direct member of). Visible only if user is org-level.
- **Persistent header indicator**: workspace name + dropdown arrow at the top-left of the dashboard. Click opens the same picker as a popover.
- **Acting-as ribbon**: when a reseller is inside a workspace they aren't a direct workspace_member of, a yellow bar pinned below the header reads `Acting as workspace: <name>. <Return to my workspace>`. Clicking the link switches back to the user's default workspace.
- **Audit log**: every action recorded in an acting-as session has `acting_user_id = reseller, target_workspace_id = client_workspace, was_acting_as = true`. UI in the audit log filters surfaces these distinctly.

## 7. White-label

- `white_labels.workspace_id` replaces `white_labels.user_id`. Branding belongs to the workspace.
- `organizations.default_*` columns hold the org's default brand. On workspace create, the workspace's `white_labels` row is initialized from these defaults; the workspace_admin can override any field.
- `branding.js` resolution order: per-workspace `white_labels` row -> org defaults -> platform defaults.
- Custom domain per workspace: V2. The `white_labels.custom_domain` column stays unused in V1.

## 8. Billing model (rollup) and lifecycle (add A)

### 8.1 Model

**The org_owner is the sole billable entity.** A workspace under a paid org has:
- NO Stripe customer.
- NO Stripe subscription.
- NO billing portal access.
- NO platform-level billing relationship of any kind.

The platform sees one customer per org: the org_owner. Stripe knows nothing about workspaces.

How a reseller charges their own clients (full price, discounted, complimentary, comped, internal-only) is **entirely the reseller's business**. The platform does not model it, enforce it, or contact the client. The `workspaces.billing_type` / `billing_notes` / `billing_contact_email` / `billing_contract_ref` columns (see §3.3.1) exist purely as the reseller's own memory and are never read by any platform code path that touches money or email.

- One Stripe subscription per **organization**, attached to `org_owner`.
- `plans.max_devices` is the org-wide cap. Sum of devices across all workspaces of the org is checked.
- Workspaces inside a paid org have no individual plan or Stripe relationship (see above).
- Self-hosted: Stripe enforcement off regardless.

### 8.2 Device-count enforcement at pairing time

```
on POST /api/provision/pair:
  org = orgOf(caller)
  total_devices = sum(devices WHERE workspace_id IN workspaces_of(org.id))
  plan = plan_of(org)
  if total_devices >= plan.max_devices and plan.id != 'enterprise':
    return 402 { error: 'Org device limit reached', current: total_devices, limit: plan.max_devices }
  ...
```

`device_status_log` shows the user a clear error: which org, which limit, which plan.

### 8.3 Subscription lifecycle (add A)

States on the `organizations` row: `active`, `past_due`, `grace`, `read_only`, `locked`. Driven by the existing Stripe webhook plus a daily cron.

Transitions:

| Event | Action |
| --- | --- |
| `invoice.payment_failed` | set `subscription_status = 'past_due'`, set `grace_period_ends = now + 7d`. Send email to org_owner + org_admins. |
| `invoice.payment_succeeded` while past_due | clear `grace_period_ends`, set `subscription_status = 'active'`. |
| daily cron, state == `past_due` AND `grace_period_ends < now` | enter `read_only`. **Reset `grace_period_ends = now + 30d`** so the read_only -> locked transition has a fresh 30-day clock and does not fire on the very next cron run. Send email. |
| `customer.subscription.deleted` (explicit cancel) | move to `read_only` immediately; set `grace_period_ends = now + 30d`. |
| daily cron, state == `read_only` AND `grace_period_ends < now` | move to `locked`. Set `locked_at = now`. |
| `checkout.session.completed` while in any non-active state | clear `grace_period_ends` and `locked_at`, set `active`. |

Behavior per state:

| State | Devices play content | Dashboard read | Dashboard write | New device pairing | Stripe portal |
| --- | --- | --- | --- | --- | --- |
| `active` | yes | yes | yes | yes | yes |
| `past_due` | yes | yes | yes | yes | yes (banner: "payment failed, update card by <date>") |
| `read_only` | **yes** (devices keep playing what they already have) | yes | **no** (locked banner, all write routes return 423) | no | yes |
| `locked` | **no** (devices receive empty playlist, fall back to a "subscription expired" splash card with org-owner email) | yes (so org_owner can see what they have) | no | no | yes |

Why this shape:
- Resellers can't tolerate "we missed a payment and 80 displays went black at 2am." Devices keep playing in `read_only`.
- 7-day grace covers most payment-method-update lag.
- 30-day grace on explicit cancel matches stripe-customer-portal cancel-at-period-end semantics.
- `locked` is the only state where devices visibly degrade. By then we've sent 4+ notifications across ~37 days.

Recovery from any state by paying invoice or re-subscribing is automatic via webhook.

#### Player and write-path mechanism in `read_only`

The `read_only` state is implemented by two surgical changes, neither of which touches what's already on the displays:

1. **Existing playlist delivery keeps working.** The device sync path (`buildPlaylistPayload`, the `device:playlist-update` socket emission, and `GET /api/provision/sync`) ignore org subscription state entirely. They read whatever is already assigned to the device's workspace and return it as today. Devices keep receiving the same content, schedules, layouts, and playlists they had at the moment the org entered `read_only`. Reconnects, screenshot push, telemetry heartbeat: all unchanged.
2. **Write routes are blocked at the middleware level.** A new `requireWritableOrg` middleware runs on every mutating route (POST/PUT/PATCH/DELETE that creates or edits workspace-scoped resources). It looks up the caller's org subscription state. If state is `read_only` or `locked`, it returns `423 Locked` with a body explaining which org and how to recover (link to Stripe portal). GET routes are unaffected.

Blocked routes in `read_only` (non-exhaustive):
`/api/devices` (POST/PUT/DELETE), `/api/provision/pair`, `/api/content` (upload, edit, delete, folder ops), `/api/playlists` (create/update/publish/items), `/api/schedules` (any write), `/api/layouts` (write), `/api/widgets` (write), `/api/video-walls` (any write), `/api/device-groups` (any write), `/api/teams`/`/api/workspaces` member changes other than the org_owner removing themselves.

Routes that stay open in `read_only`:
all GETs, Stripe billing portal/checkout (so the customer can pay and recover), `/api/auth/*` (login, switch-workspace, logout), `/api/orgs/:id/usage` (visibility), `/api/activity` (visibility), platform_admin endpoints.

In `locked`, the same write-routes stay blocked AND `buildPlaylistPayload` returns `{ assignments: [], suspended: true, message: 'Subscription expired', detail: '<org_owner email>' }`. The existing "suspended" branch in the web player already renders this splash; we just wire it to org state.

#### Uniform application to every workspace (add D)

When an org enters `read_only` or `locked`, **all of its workspaces are affected identically, regardless of `billing_type`**. There is no special protection for `internal` or `client_complimentary` workspaces. The reseller's payment problem affects every workspace under them. This is intentional: the platform has exactly one billable customer (the org_owner), and managing client expectations during a payment lapse is the reseller's responsibility, not the platform's.

### 8.4 Free tier

Free tier = `plans.id = 'free'`, `max_devices = 1`. Behaves identically to a paid plan that happens to have a low cap. Trial-expiry behavior in `deviceSocket.js` already exists and stays; it now keys off org state instead of user state.

## 9. Per-workspace usage rollup (add B)

Read-only visibility, no enforcement.

`GET /api/orgs/:id/usage` returns:

```json
{
  "organization_id": "org_abc",
  "plan_id": "pro",
  "max_devices": 100,
  "total_devices": 95,
  "subscription_status": "active",
  "workspaces": [
    { "workspace_id": "ws_acme", "name": "AcmeClient",   "device_count": 80, "online": 78, "offline": 2, "billing_type": "client_billable" },
    { "workspace_id": "ws_foo",  "name": "FooClient",    "device_count": 15, "online": 15, "offline": 0, "billing_type": "client_complimentary" },
    { "workspace_id": "ws_demo", "name": "Sales Demo",   "device_count": 2,  "online": 2,  "offline": 0, "billing_type": "internal" }
  ]
}
```

`billing_type` is included so the reseller can see their mix at a glance (paying clients vs comped vs internal use) without opening each workspace. The org_owner UI may use it for a stacked summary (e.g. "92 client_billable, 15 client_complimentary, 2 internal of 100 cap").

UI: in the org_owner / org_admin org-settings view, a stacked horizontal bar shows each workspace's slice of the org's cap, plus a row table with raw counts. Click a workspace name to switch into it (acting-as). No allocation UI - resellers eyeball the bar and add devices wherever they want.

`workspace_admin` and below cannot call this endpoint (their `org_id` doesn't resolve, returns 403).

## 10. Device pairing while acting-as (add C)

Pairing flow is workspace-scoped: a paired device's `workspace_id` is whatever workspace the user is currently in at the moment of confirmation.

### 10.1 Reseller acting inside a client workspace

1. The acting-as ribbon is showing (`Acting as workspace: Acme`).
2. Reseller clicks "Add display" on the dashboard.
3. The "Pair Display" modal opens. Top of modal:
   ```
   New display will be added to: Acme  (you are acting as this workspace)
   ```
   with a button `Change target workspace` that opens a workspace dropdown limited to workspaces of the current org (resellers cannot pair a device into a workspace outside their org).
4. Reseller enters pairing code, clicks "Pair".
5. Device row is inserted with:
   - `workspace_id = ws_acme` (the acting-as workspace, or the target from step 3 if changed)
   - `user_id = reseller.id` (created_by record)
   - `team_id = ws_acme` (legacy column for compatibility shim)
6. Org-wide device count enforcement runs (section 8.2). If over cap, return 402 BEFORE inserting the row.
7. Activity log: `acting_user_id = reseller, workspace_id = ws_acme, action = 'device.paired', was_acting_as = true`.

### 10.2 Reseller NOT acting-as (in their own context)

Two sub-cases. We pick one for V1.

**V1 default: force a workspace pick at pairing time.**

When `org_owner` / `org_admin` is in their org-level context (no specific workspace selected, e.g. on the org settings page), the "Add display" CTA is disabled with a tooltip `Enter a workspace first to pair a device`. They cannot pair from the org settings page.

When they are in their personal default workspace (which is just one of the org's workspaces), pairing works as in 10.1 with that workspace as the target.

Why force the pick rather than land in personal default:
- Resellers consistently report: "I paired five devices into the wrong workspace because I forgot to switch first." Forcing the explicit choice prevents this footgun.
- Personal-default workspace concept is fragile for resellers who have no personal use case (they only manage clients).

**Alternative (rejected for V1):** Allow pairing from org-level context and require a workspace selector inside the pairing modal. Adds an extra step for every single-workspace customer (the majority of self-hosted users). Reconsidered if real-world feedback contradicts.

### 10.3 Workspace_admin / editor / viewer

Pairing target is always the workspace they're in. No selector shown. Their session has exactly one workspace; the modal just says `New display will be added to: <workspace name>`.

## 11. Self-hosted bootstrap

On a fresh self-hosted install (`SELF_HOSTED=true`, empty database):

1. First registrant becomes `users.role = 'platform_admin'`.
2. Same registrant becomes the `org_owner` of an auto-created organization named `<name>'s organization`.
3. Same registrant becomes `workspace_admin` of an auto-created workspace named `Default`.
4. `plans.id = 'enterprise'` is force-assigned to the org with `max_devices = 999999`. No Stripe lookup.

Subsequent registrants when `DISABLE_REGISTRATION=false`:
- Lands as `users.role = 'user'`, no org or workspace memberships.
- The platform_admin must invite them to a workspace (or grant org_admin).
- Frontend shows "No workspace yet. Ask your administrator for access."

When `DISABLE_REGISTRATION=true`: registration is closed at the route level. Bootstrap user is the only auto-created identity; others must arrive via invite.

Self-hosted instances may create multiple organizations. The `platform_admin` UI exposes a "create new organization" button. No Stripe involvement.

## 12. Socket.IO scoping

- **Device sockets** (`/device`): unchanged. They join the `device_id` room as today.
- **Dashboard sockets** (`/dashboard`): join `ws:<current_workspace_id>` instead of an implicit per-user room.
  - When the user switches workspace, the socket leaves the old room and joins the new one. Frontend emits `dashboard:switch-workspace` with the new id; server validates membership/acting-as and updates rooms.
- Server emits `dashboard:device-status`, `dashboard:screenshot-ready`, `dashboard:playback-progress`, `dashboard:wall-changed` to `ws:<workspace_id>` of the affected resource, not globally.
- The existing audience filter (every dashboard reloads after `dashboard:wall-changed` and re-fetches via the access-controlled GET) means even if a stray broadcast reaches a wrong workspace, the GET would 403; for V1 we tighten the broadcast at emit time anyway.

## 13. Phase-by-phase rollout

### Phase 0 - design (THIS DOC). Done on approval.

### Phase 1 - database and migration
- Add the four new tables.
- Add `workspace_id` / `organization_id` columns on existing tables.
- Backfill: every existing user becomes an org + workspace(s) per section 4.
- Snapshot pre-migration DB before any ALTER.
- Validation script: row-count parity per user before vs after.
- No route changes yet. Frontend unchanged. Existing logins still work because middleware reads `team_id` as before in V0 paths.
- Gate: visual test - log in as three different existing users, see exactly the same dashboard as before migration.

### Phase 2 - backend permissions and scoping
- Org and workspace models in `server/models/` (or wherever the repo wants them).
- Auth middleware resolves `current_workspace_id`. JWT gets `current_workspace_id`. `/api/auth/me` returns memberships.
- `/api/auth/switch-workspace` endpoint.
- Permission helpers (`can()` per section 2.5).
- Every existing route: replace `user_id` filter with `workspace_id` filter. Keep `user_id` writes as created_by.
- Socket.IO room scoping (section 12).
- Gate: regression test of every route under the new scoping. Existing client unchanged, all functionality works.

### Phase 3 - frontend
- Workspace picker view at `#/select-workspace`.
- Header workspace indicator + dropdown.
- Acting-as ribbon.
- Org settings page with: members, workspaces list, branding defaults, usage rollup (add B). Rollup table includes a `billing_type` column.
- Workspace settings page: members, branding override, delete-workspace (org_owner only).
- Workspace settings "Billing (reseller use)" section (add D), visible only to `org_owner` and `org_admin`:
  - `billing_type` dropdown (client_billable / client_complimentary / internal)
  - `billing_notes` textarea
  - `billing_contact_email` field
  - `billing_contract_ref` field
  - Help text: "This information is for your own records. ScreenTinker does not bill or contact clients - that is between you and them."
  - The whole section is gated server-side and hidden client-side from `workspace_admin` and below.
- Updated pairing modal per section 10 (target workspace banner / selector).

### Phase 4 - billing
- Move Stripe customer/subscription writes to the org row.
- Device-count enforcement at pair time queries the org rollup.
- Webhook handlers update the org's lifecycle state machine (section 8.3).
- `read_only` and `locked` banners on dashboard chrome.
- Daily cron job for grace-period expiry transitions.

### Phase 5 - self-hosted validation
- Fresh `SELF_HOSTED=true` install on a clean SQLite DB.
- First registrant becomes platform_admin + org_owner + workspace_admin.
- `DISABLE_REGISTRATION=true` still works.
- Multi-org creation works (platform_admin can spin up multiple orgs for separate resellers).
- Stripe routes return `{ enabled: false }` and the billing UI hides.

## 14. Decisions deferred to V2

- Subdomain-per-workspace (`client.screentinker.com`) and per-workspace custom domain via CNAME. Requires nginx automation + cert lifecycle (likely a sidecar like caddy or acme.sh integration).
- Per-workspace device-count caps (allocation). V1 shows the rollup view (add B); allocation UI follows.
- **Per-client invoicing reports (add D)**: per-workspace soft caps combined with `billing_type` metadata enables a future "invoicing CSV" - V2 could render, for each `client_billable` workspace, a device-month consumption summary the reseller can import into their own invoicing system. Purely a reseller convenience; no money flows through ScreenTinker. Flagged here, deferred.
- Path-versioned `/api/workspaces/:wid/...` form with 308 redirects from legacy paths.
- Drop the now-unused `users.plan_id`, `users.stripe_*`, `users.subscription_*` columns. Stay nullable in V1, drop in V2.
- Drop the `team_id` compatibility column on resource tables.
- Nested teams inside a workspace. Not asked for. Don't add without a concrete request.
- "Transfer workspace between organizations" - rare; defer until requested.

## 15. Open questions still on the table

None blocking Phase 1. The following are nice-to-have clarifications you can answer at any time before Phase 3:

- **Default workspace name format**: current proposal is `Default`. Resellers might prefer `<client name>` only with no `Default` workspace at all. We can confirm during Phase 3 when the workspace-create UX lands.
- **Email notifications for invites**: today's team invite email template gets reused for both org-member and workspace-member invites with subject lines that distinguish them. Confirm copy in Phase 3.
- **Activity log retention**: currently unlimited. With orgs, do we want a per-org retention cap (90 days default, configurable on enterprise)? Defer to V2.

End of design doc.
