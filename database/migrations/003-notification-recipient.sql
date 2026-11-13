-- Administrator alerts are addressed to a PERSON, not to a profile.
--
-- Until now a notification could be targeted only by marketing profile
-- (target_profile_id) or left as a broadcast. Administrator alerts — a
-- reservation or guest deleted, an account locked, a role changed, data
-- exported — go to every ADMIN and to anyone an administrator has granted
-- 'notifications.admin'. Administrators usually have no profile at all, and a
-- single shared row would give every recipient one shared read state: the first
-- person to open the bell would mark the alert read for everybody else.
--
-- So each recipient gets their own row, keyed by user. NULL keeps the existing
-- meaning (profile-targeted or broadcast) for every row already stored.
-- Deleting a user takes their alerts with them; accounts are disabled rather
-- than deleted in normal use, so this only matters for offline recovery.

ALTER TABLE notifications ADD COLUMN target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(target_user_id, read_at);
