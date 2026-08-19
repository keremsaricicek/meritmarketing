-- 001 — initial production schema.
--
-- Conventions used throughout:
--   * business dates  TEXT 'YYYY-MM-DD'   (check_in, check_out) — no zone, no time
--   * system instants  TEXT ISO-8601 UTC  (created_at, deleted_at, …)
--   * every mutable business row carries row_version, so a future central API
--     can do optimistic concurrency without another migration
--   * historical rows are never destroyed by normal use; they are tombstoned

-- ------------------------------------------------------------- profiles
-- 'marketing' profiles own guests; 'staff' profiles exist for attribution but
-- are never counted as Active Marketing.
CREATE TABLE profiles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name         TEXT    NOT NULL,
  kind              TEXT    NOT NULL DEFAULT 'marketing' CHECK (kind IN ('marketing','staff')),
  employment_status TEXT    NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','inactive')),
  passport_no       TEXT,
  phone             TEXT,
  nationality       TEXT,
  email             TEXT,
  photo_name        TEXT,
  notes             TEXT,
  created_at        TEXT    NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TEXT    NOT NULL,
  updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  archived_at       TEXT,
  row_version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_profiles_kind_status ON profiles(kind, employment_status);

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('ADMIN','MANAGER','MARKETING')),
  profile_id    INTEGER REFERENCES profiles(id) ON DELETE RESTRICT,
  full_name     TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  row_version   INTEGER NOT NULL DEFAULT 1,
  -- A MARKETING account is meaningless without the profile that defines its
  -- scope: scopeProfileId() would have nothing to narrow by and the session
  -- would either see everything or nothing.
  CHECK (role <> 'MARKETING' OR profile_id IS NOT NULL)
);
CREATE INDEX idx_users_profile ON users(profile_id);

-- ------------------------------------------------------------ customers
CREATE TABLE customers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  code                 TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  full_name            TEXT    NOT NULL,
  -- registered = a real guest of the property. An unregistered lead carries no
  -- status badge at all (NO RECORD / COLD / ACTIVE are registered-only).
  registered           INTEGER NOT NULL DEFAULT 1 CHECK (registered IN (0,1)),
  phone                TEXT,
  email                TEXT,
  passport_no          TEXT,
  nationality          TEXT,
  photo_name           TEXT,
  notes                TEXT,
  -- CURRENT ownership. Mutable. Distinct from the immutable historical
  -- attribution held on each reservation.
  marketing_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  created_at           TEXT    NOT NULL,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at           TEXT    NOT NULL,
  updated_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at           TEXT,
  deleted_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  row_version          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_customers_owner    ON customers(marketing_profile_id);
CREATE INDEX idx_customers_deleted  ON customers(deleted_at);
CREATE INDEX idx_customers_name     ON customers(full_name COLLATE NOCASE);
CREATE INDEX idx_customers_created  ON customers(created_at);

-- --------------------------------------------------------- reservations
-- Lifecycle is DERIVED from these columns, never stored as a mutable status
-- string a client could set:
--   deleted_at   set -> DELETED    (wins over everything, excluded from operations)
--   cancelled_at set -> CANCELLED
--   otherwise    -> UPCOMING / CHECKED_IN / COMPLETED from the calendar dates
CREATE TABLE reservations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id            INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  check_in               TEXT    NOT NULL CHECK (check_in  GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  check_out              TEXT    NOT NULL CHECK (check_out GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- HISTORICAL attribution. Immutable once written: reassigning the guest must
  -- never rewrite who actually invited them on a past stay.
  invited_by_profile_id  INTEGER REFERENCES profiles(id) ON DELETE RESTRICT,
  reservation_note       TEXT,
  created_at             TEXT    NOT NULL,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at             TEXT    NOT NULL,
  updated_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at           TEXT,
  cancelled_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancellation_reason    TEXT,
  deleted_at             TEXT,
  deleted_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deletion_reason        TEXT,
  row_version            INTEGER NOT NULL DEFAULT 1,
  CHECK (check_out >= check_in),
  -- A tombstone without an actor is unauditable, which defeats the point of
  -- keeping the row at all.
  CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL)
);
CREATE INDEX idx_res_customer   ON reservations(customer_id);
CREATE INDEX idx_res_invited    ON reservations(invited_by_profile_id);
CREATE INDEX idx_res_checkin    ON reservations(check_in);
CREATE INDEX idx_res_checkout   ON reservations(check_out);
CREATE INDEX idx_res_deleted    ON reservations(deleted_at);
CREATE INDEX idx_res_cancelled  ON reservations(cancelled_at);
-- The hot path: "qualifying activity for this guest" asks for non-deleted,
-- non-cancelled rows ordered by check_in.
CREATE INDEX idx_res_qualifying ON reservations(customer_id, deleted_at, cancelled_at, check_in DESC);

-- ------------------------------------------------------------ crm_notes
CREATE TABLE crm_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  note        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT    NOT NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at  TEXT,
  deleted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  row_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_crm_customer ON crm_notes(customer_id, deleted_at);

-- --------------------------------------------------- assignment_history
-- Every change of CURRENT ownership, with the explicit/derived distinction the
-- protection rule depends on. An explicit event is a management decision; a
-- derived event is the system inferring ownership from a booking.
CREATE TABLE assignment_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id         INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  previous_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  new_profile_id      INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  event_type          TEXT    NOT NULL CHECK (event_type IN ('explicit','derived')),
  source              TEXT,
  reservation_id      INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  actor_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at          TEXT    NOT NULL
);
CREATE INDEX idx_assign_customer ON assignment_history(customer_id, changed_at);
CREATE INDEX idx_assign_explicit ON assignment_history(customer_id, event_type, changed_at);

-- -------------------------------------------------------- notifications
CREATE TABLE notifications (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  type                  TEXT    NOT NULL,
  title                 TEXT    NOT NULL,
  message               TEXT,
  target_profile_id     INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  target_role           TEXT CHECK (target_role IS NULL OR target_role IN ('ADMIN','MANAGER','MARKETING')),
  related_customer_id   INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  related_reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
  read_at               TEXT,
  created_at            TEXT    NOT NULL
);
CREATE INDEX idx_notif_target ON notifications(target_profile_id, read_at);

-- ------------------------------------------------------------ audit_log
-- Append-only from the application's point of view: there is no update or
-- delete verb over this table in the IPC surface.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT    NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT,
  description TEXT,
  metadata    TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_entity  ON audit_log(entity_type, entity_id);

-- ------------------------------------------------------------- settings
-- Shared application settings. Personal preferences live in user_preferences
-- so one operator's theme can never become everybody's theme.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE user_preferences (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------- photos
-- Files live on disk under userData/photos; the database holds metadata only.
CREATE TABLE photos (
  name         TEXT PRIMARY KEY,
  mime_type    TEXT NOT NULL,
  byte_size    INTEGER NOT NULL CHECK (byte_size > 0),
  sha256       TEXT,
  created_at   TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
