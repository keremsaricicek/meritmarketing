'use strict';
/* Automatic backups.
 *
 * Settings has offered Automatic Backup, a frequency and a retention count
 * since the migration. The preferences were stored faithfully and nothing ever
 * read them: no automatic backup was ever created. A control that saves and
 * then does nothing is worse than one that is absent, because the operator
 * believes they are covered.
 *
 * Everything here runs at startup, through the SAME trusted backup service the
 * Settings screen uses — there is no second way to write a backup.
 *
 * Two decisions worth stating:
 *
 *   Local calendar days, not 24-hour periods. "Daily" means "once on each day
 *   the operator worked", so a shift starting at 09:00 and another at 08:00 the
 *   next morning are two days, 23 hours apart. Comparing instants would skip
 *   the second one.
 *
 *   Retention never touches a manual backup. `prune` only considers names it
 *   generated itself; a backup the owner took deliberately is theirs.
 */

const AUTOMATIC_LABEL = 'auto';

const DEFAULTS = Object.freeze({
  enabled: true,
  frequency: 'startup',
  keep: 10,
});

const VALID_FREQUENCIES = new Set(['startup', 'daily', 'weekly']);

/** The local calendar date of an instant, as a business date. */
function localDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whole local calendar days between two business dates. */
function daysBetween(a, b) {
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((parse(b) - parse(a)) / 86400000);
}

function readSettings(db) {
  const settings = {};
  try {
    for (const row of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'backup.%'").all()) {
      settings[row.key] = row.value;
    }
  } catch (_) { /* a database too broken to read settings has bigger problems */ }

  const rawKeep = Number(settings['backup.keep']);
  const frequency = settings['backup.frequency'];
  return {
    enabled: (settings['backup.auto_enabled'] ?? String(DEFAULTS.enabled)) !== 'false',
    frequency: VALID_FREQUENCIES.has(frequency) ? frequency : DEFAULTS.frequency,
    keep: Number.isFinite(rawKeep) && rawKeep > 0 ? Math.min(Math.round(rawKeep), 200) : DEFAULTS.keep,
  };
}

/** The most recent AUTOMATIC backup, or null. Manual ones are not considered. */
function latestAutomatic(backup, ctx) {
  const all = backup.list(ctx) || [];
  const automatic = all.filter((b) => b.name.endsWith(`-${AUTOMATIC_LABEL}.mmhbackup`));
  return automatic.length ? automatic[0] : null;
}

/**
 * Is a backup due right now?
 * Pure, so the schedule can be tested without touching the disk.
 */
function isDue({ frequency, latestAt, now = new Date() }) {
  if (frequency === 'startup') return true;
  if (!latestAt) return true;                 // never run: always due
  const last = localDate(latestAt);
  const today = localDate(now);
  if (!last || !today) return true;
  const elapsed = daysBetween(last, today);
  if (frequency === 'daily') return elapsed >= 1;
  if (frequency === 'weekly') return elapsed >= 7;
  return false;
}

/**
 * Run once, during startup, after the database is open and healthy.
 *
 * Never throws. A backup that cannot be written is a logged problem, not a
 * reason the operator cannot get to work — and it never touches the live
 * database, because `create` snapshots through SQLite's own backup API.
 */
async function runAtStartup({ db, backup, ctx, log = () => {}, now = new Date() }) {
  const config = readSettings(db);
  if (!config.enabled) {
    log('info', 'backup.auto-skipped', { reason: 'disabled' });
    return { ran: false, reason: 'disabled', config };
  }

  let latest = null;
  try { latest = latestAutomatic(backup, ctx); }
  catch (err) { log('warn', 'backup.auto-list-failed', { message: err.message }); }

  if (!isDue({ frequency: config.frequency, latestAt: latest && latest.createdAt, now })) {
    log('info', 'backup.auto-skipped', { reason: 'not-due', frequency: config.frequency });
    return { ran: false, reason: 'not-due', config, latest: latest && latest.name };
  }

  let created = null;
  try {
    created = await backup.create(ctx, { label: AUTOMATIC_LABEL, system: true });
    log('info', 'backup.auto-created', { name: created.name });
  } catch (err) {
    /* Sanitised: the message can name a path. */
    log('error', 'backup.auto-failed', { message: String(err && err.message).slice(0, 200) });
    return { ran: false, reason: 'failed', config, error: err && err.code };
  }

  let pruned = [];
  try { pruned = (backup.prune({ keepAutomatic: config.keep }) || {}).removed || []; }
  catch (err) { log('warn', 'backup.auto-prune-failed', { message: err.message }); }

  return { ran: true, created: created.name, pruned, config };
}

module.exports = { runAtStartup, isDue, readSettings, localDate, daysBetween, DEFAULTS, AUTOMATIC_LABEL };
