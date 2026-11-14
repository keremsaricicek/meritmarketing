-- 004 — guest features: follow-up reminders, tags, birthdays and special
-- dates, and the pointer a merged duplicate keeps to the guest it became.
--
-- ADDITIVE ONLY. Every statement below creates a table, an index or a nullable
-- column. Nothing is dropped, renamed or rewritten, so a book that was written
-- by 1.1.x opens unchanged and every existing row keeps its meaning. The
-- application takes a backup before this runs, and the migrator rolls the whole
-- file back if any statement fails.

-- ------------------------------------------------------------ customers
-- A guest's date of birth: a business date (YYYY-MM-DD, no zone). Optional.
ALTER TABLE customers ADD COLUMN birth_date TEXT
  CHECK (birth_date IS NULL OR birth_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

-- A duplicate merged into another guest is archived (deleted_at), not
-- destroyed, and remembers which guest it was merged into so its old Guest ID
-- can still be traced. NULL for every guest that was never merged.
ALTER TABLE customers ADD COLUMN merged_into_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_customers_merged ON customers(merged_into_id);

-- Duplicate detection looks guests up by passport number.
CREATE INDEX IF NOT EXISTS idx_customers_passport ON customers(passport_no COLLATE NOCASE);

-- ------------------------------------------------------------ reminders
-- "Remind me on <date>" on a CRM note. A reminder belongs to the person who
-- set it (created_by): it is their follow-up, raised on their dashboard and in
-- their bell. It is tied to the guest, and to the note it was written with
-- when there is one.
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  crm_note_id INTEGER REFERENCES crm_notes(id) ON DELETE SET NULL,
  due_date    TEXT    NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at  TEXT    NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT    NOT NULL,
  done_at     TEXT,
  done_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_owner    ON reminders(created_by, done_at, due_date);
CREATE INDEX IF NOT EXISTS idx_reminders_customer ON reminders(customer_id, done_at);
CREATE INDEX IF NOT EXISTS idx_reminders_note     ON reminders(crm_note_id);

-- ----------------------------------------------------------------- tags
-- A shared vocabulary of labels (VIP, High budget, Problematic …). The colour
-- is a NAME from a fixed palette, never a CSS value, so nothing stored here can
-- become a style declaration.
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  color      TEXT    NOT NULL DEFAULT 'slate'
             CHECK (color IN ('slate','red','orange','amber','green','teal','blue','violet','pink','gold')),
  created_at TEXT    NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS customer_tags (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (customer_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_tags_tag ON customer_tags(tag_id);

-- -------------------------------------------------------- special dates
-- Recurring dates worth a call: an anniversary, a name day. Month and day
-- only — they come round every year.
CREATE TABLE IF NOT EXISTS customer_special_dates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  month       INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day         INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  created_at  TEXT    NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_special_dates_customer ON customer_special_dates(customer_id);
