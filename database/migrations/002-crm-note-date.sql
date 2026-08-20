-- A CRM note carries the date the CONVERSATION happened, not the date it was
-- typed. The operator can record Monday's phone call on Wednesday, and the
-- guest's activity timeline has to show Monday.
--
-- The prototype had this and the Add Note form still shows the Date input, but
-- the migration dropped the column: the renderer sent `noteDate`, the strict
-- schema refused it, and the timeline read `n.note_date` — a field that existed
-- nowhere and therefore rendered as an em dash. This restores the baseline
-- behaviour rather than deleting a control the operator uses.
--
-- It is a business date (YYYY-MM-DD, no zone), like check_in — never an instant.
-- `created_at` stays exactly what it was: when the row was written.

ALTER TABLE crm_notes ADD COLUMN note_date TEXT;

-- Existing notes are dated by when they were recorded, converted to the local
-- calendar day. A note written at 01:00 in Turkey belongs to that local day,
-- not to the previous one in UTC.
UPDATE crm_notes SET note_date = date(created_at, 'localtime') WHERE note_date IS NULL;

-- The activity timeline and the COLD/ACTIVE threshold both sort on this.
CREATE INDEX IF NOT EXISTS idx_crm_notes_date ON crm_notes(customer_id, note_date DESC);
