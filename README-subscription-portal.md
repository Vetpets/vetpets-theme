# VetPets Subscription Portal — implementation notes

Frontend lives in this theme. **Everything that touches Phoenix or VetPoints does
not, and must not.** This file is the contract between the two.

Status: frontend pruned to the Phoenix-supported surface and running on mock
data. No backend exists yet. No live Phoenix call has been made.

---

## 1. Architecture gate — result

The repository was inspected for an existing secure runtime. There is none:

| Looked for | Found |
|---|---|
| `wrangler.toml` / `package.json` / `vercel.json` / `netlify.toml` / `Dockerfile` / `fly.toml` | none |
| Server-side source (`.ts` / `.mjs` / `.py` / `.rb` / `.go`) | none |
| Shopify App Proxy route | none |
| `.env` of any kind | none |
| Phoenix credentials in theme files | none — verified by test |

The repo is exclusively Shopify theme directories. `layout/theme.liquid` does
contain a Phoenix **checkout** integration (public `phoenix.min.js` SDK plus the
public `secureorder.shopvetpets.com` host). That is a browser-side checkout
handoff carrying no credential, and it is unrelated to the Partner CRM API.

**A Shopify theme cannot hold Phoenix credentials.** Theme files are served
verbatim to every visitor. Nothing in `assets/`, `snippets/`, `sections/`,
`layout/`, `templates/` or theme settings is private.

No `.env.example` has been added, because there is no backend directory to put
it in. The variable names are listed in §5 instead.

---

## 2. Supported portal surface

Everything below maps to a documented Phoenix Partner API operation. Anything
not listed is not a portal capability and has no code path in the theme.

### Reads

| Portal need | Phoenix |
|---|---|
| Resolve customer from verified email | `GET /customers?Email=` |
| Subscription, items, prices, currency, next billing date | `GET /order-details?CustomerId=` |
| Delivery / order history | `GET /order-details`, `GET /transaction-history` |
| Product metadata | `GET /products?StoreId=&Subscription=true` |
| Cadence labels | `GET /billing-types` |
| Store context | `GET /stores` |

### Mutations

| Portal action | Phoenix |
|---|---|
| Skip next delivery | `POST /update-next-billing-date` — next date + one interval |
| Delay 7 / 15 / 30 days | `POST /update-next-billing-date` |
| Reschedule (incl. undo skip) | `POST /update-next-billing-date` |
| Cancel | `POST /cancel-subscription` — `Notes` carries the reason code |
| Reactivate | `POST /activate-subscription` |

### Deliberately absent

Change quantity · swap product · add one-time item · update card · update
address · change frequency · pause/resume.

Phoenix documents no portal-scope operation for these, so the portal must not
offer them. `/change-subscription-product`, `/add-order` and `/refund` are
documented but explicitly out of scope for this phase.

Address and payment are still **shown**, read-only, from `/order-details`.
Products and quantities are shown read-only. Support is the route to change them.

There is no `paused` state anywhere: Phoenix has no pause operation, so the only
statuses are `active` and `cancelled`.

---

## 3. Recommended backend — one Cloudflare Worker + D1

One Worker, one D1 database, one repository. Chosen because it is the smallest
thing that can hold a secret, has a real database for the ledger and audit log,
needs no container or VPC, and sits behind Shopify's App Proxy on the storefront
origin so the browser never sees a third-party host.

### Repository boundary

A **new, separate, private repository** — `vetpets-subscription-backend`.

It must not live in `vetpets-theme`. The theme is deployed by pushing files that
are then publicly served; a secret in that repo is a secret on the internet.

```
vetpets-subscription-backend/
  wrangler.toml           # bindings + routes; no secret values
  .env.example            # names only
  migrations/
    0001_init.sql
  src/
    index.ts              # router
    auth/                 # magic link issue + verify, session cookie
    phoenix/              # the only module that knows the Phoenix base URL
    loyalty/              # ledger sync, reservation, redemption
    admin/                # Redemption Queue
    lib/                  # idempotency, rate limit, audit, request-id
```

Shopify side: one App Proxy, prefix `apps`, subpath `subscriptions`, pointing at
the Worker. That makes the portal call `/apps/subscriptions/*` — same origin,
first-party cookies, no CORS, no vendor hostname in the browser.

### Environment variables — names only, values set as Worker secrets

```
PHOENIX_BASE_URL
PHOENIX_API_TOKEN          # Bearer
PHOENIX_PARTNER_ID         # partnerId header
PHOENIX_PARTNER_TOKEN      # partnerToken header
PHOENIX_STORE_ID
SHOPIFY_APP_PROXY_SECRET   # verifies the proxy signature
SESSION_SIGNING_KEY
MAGIC_LINK_PEPPER
EMAIL_API_KEY
ADMIN_ALLOWED_EMAILS
LOYALTY_POINTS_PER_RENEWAL # default 100
LOYALTY_POINT_EXPIRY_DAYS  # default 365
ENVIRONMENT                # staging | production
```

Set with `wrangler secret put NAME`. Never committed, never in `wrangler.toml`,
never in the theme.

### Routes

Customer-facing, behind App Proxy signature + session:

```
POST /auth/request-link          { email }            202 always, neutral
POST /auth/verify                { token }            sets session cookie
POST /auth/sign-out
GET  /me
GET  /subscription
GET  /deliveries
GET  /loyalty                    syncs ledger, then returns balance
GET  /loyalty/rewards
POST /loyalty/redemptions        { rewardId }         -> pending_manual
POST /subscription/skip
POST /subscription/delay         { days }
POST /subscription/reschedule    { date }
POST /subscription/cancel        { reason }
POST /subscription/reactivate    { startDate }
```

Internal, separate auth:

```
GET   /admin/redemptions?status=
PATCH /admin/redemptions/:id     { status, note }
GET   /admin/audit?entity=&id=
```

Every mutation requires an `Idempotency-Key` from the client; the server maps it
to a stable Phoenix `request-id` so a retry cannot double-apply.

**The browser never sends a CustomerId.** The server resolves it from the session
and ignores any identifier in the request body.

---

## 4. VetPoints — our ledger, not Phoenix

VetPoints is not a Phoenix concept. It is ours, and it must be auditable.

### Tables

```sql
CREATE TABLE customer (
  id                TEXT PRIMARY KEY,       -- our id
  phoenix_customer_id TEXT UNIQUE NOT NULL,
  email_hash        TEXT UNIQUE NOT NULL,   -- lookup without storing plaintext
  email             TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE magic_link (
  id           TEXT PRIMARY KEY,
  email_hash   TEXT NOT NULL,
  token_hash   TEXT UNIQUE NOT NULL,        -- hashed + peppered, never plaintext
  expires_at   TEXT NOT NULL,               -- 15 minutes
  consumed_at  TEXT,                        -- single use
  created_ip   TEXT,
  created_at   TEXT NOT NULL
);

-- Append-only. Never UPDATE a row; correct by writing an offsetting entry.
CREATE TABLE points_ledger (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customer(id),
  delta          INTEGER NOT NULL,          -- + earn, − spend/reverse
  reason         TEXT NOT NULL,             -- renewal | reversal | redemption_reserved
                                            -- | redemption_released | manual_adjustment
  source_ref     TEXT,                      -- Phoenix order id for renewals
  redemption_id  TEXT,
  expires_at     TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (customer_id, reason, source_ref)  -- an order can never award twice
);

CREATE TABLE redemption (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customer(id),
  reward_id         TEXT NOT NULL,
  reward_name       TEXT NOT NULL,
  points_cost       INTEGER NOT NULL,
  status            TEXT NOT NULL,          -- pending_manual | added_to_order
                                            -- | fulfilled | rejected
  next_billing_date TEXT,                   -- snapshot for the queue
  admin_note        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE reward_catalogue (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  points_cost INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,                -- customer:<id> | admin:<email> | system
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  request_id  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE idempotency (
  key          TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  operation    TEXT NOT NULL,
  request_id   TEXT NOT NULL,               -- reused verbatim on retry
  response_json TEXT,
  created_at   TEXT NOT NULL
);
```

Balance is always `SELECT SUM(delta)` over non-expired rows. It is never stored
as a mutable number, so it cannot drift.

### Earning

Sync runs before any balance is displayed and again immediately before
redemption. It reads `/order-details` and `/transaction-history`, and for each
**settled recurring** order not already in the ledger inserts
`+LOYALTY_POINTS_PER_RENEWAL` with `source_ref = <Phoenix order id>`. The unique
constraint makes double-awarding impossible even if sync runs twice
concurrently.

Refunded, voided or cancelled amounts produce an offsetting `reversal` row
referencing the same order. Initial orders and one-time charges do not earn.

### Redemption lifecycle

1. Customer taps a reward.
2. Backend syncs the ledger, then validates balance and eligibility.
3. In one transaction: insert `redemption` as `pending_manual` **and** a
   `redemption_reserved` ledger row of `−points_cost`. Points are reserved, not
   spent — the atomicity is what stops double-spend.
4. Customer sees exactly: *"Your reward request has been received. It will be
   added to an upcoming delivery."* Never a shipping claim.
5. The reward shows as **Requested** and cannot be requested again.
6. Redemption Queue shows: customer name and email, Phoenix CustomerId, reward,
   points, next billing date, status, requested-at.
7. Admin sets `added_to_order` → `fulfilled`, or `rejected`.
8. `rejected` writes a compensating `redemption_released` row of
   `+points_cost`. The balance returns; nothing is deleted.
9. Every transition writes to `audit_log` with before/after and request-id.

Fulfilment is manual by design. The portal never claims a reward has shipped.

---

## 5. Security requirements

- Phoenix credentials exist only as Worker secrets. Not in Liquid, theme JS,
  browser storage, committed files or public env vars. Enforced by a test that
  scans every browser-delivered portal file for the Phoenix host, `phxcrm`,
  `partnerId`, `partnerToken`, `Bearer` and `x-api-key`.
- The browser never supplies an authoritative CustomerId; the server resolves it
  from the verified session.
- Magic links: single-use, 15-minute expiry, stored **hashed and peppered**,
  consumed atomically.
- `/auth/request-link` returns `202` and the same body whether or not the
  account exists. The portal shows the same screen either way.
- Rate limits: per-email and per-IP on login; per-session on mutations.
- `request-id` is generated server-side and **reused verbatim** when retrying the
  same mutation, so Phoenix sees one logical request.
- Idempotency key required on every mutation and redemption.
- Audit log on every mutation and every redemption transition.
- App Proxy signature verified on every request.
- **The Phoenix endpoint is PROD.** There is no sandbox. Every write hits real
  billing. Nothing may be called until the founder authorises a specific test on
  a specific founder-controlled subscription.

---

## 6. Theme-side configuration

`sections/subscription-portal.liquid` exposes:

- **Data mode** — `mock` (default) or `live`. In `live` the controller calls
  `createHttpAdapter`; `createMockAdapter` throws `mock_in_production`, and all
  static design placeholders are wiped before first paint. A fabricated
  VetPoints balance cannot reach a real customer.
- **Backend base path** — default `/apps/subscriptions`. Same-origin only.

Review tools (`?spp_dev=1`) are ignored entirely in `live` mode.

Mock mode remains fully working for visual QA.
