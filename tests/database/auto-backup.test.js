'use strict';
/* AUTOMATIC BACKUP — the setting that did nothing.
 *
 * Settings has offered Automatic Backup, a frequency and a retention count
 * since the migration. The preferences were written to the database faithfully
 * and nothing ever read them: no automatic backup was ever created, on any
 * schedule, ever. The operator would have discovered that on the day they
 * needed one.
 *
 * The schedule is checked as a pure function, because the interesting cases are
 * about calendar days rather than elapsed time and are impossible to exercise
 * by waiting. The rest runs the real service against a real database.
 */

const fs = require('fs');
const path = require('path');
const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const autoBackup = require('../../src/main/backup/auto-backup');
const backupFactory = require('../../src/main/backup/backup-service');

const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0).toISOString();

module.exports = async function () {
  const s = new Suite('database/auto-backup');

  // ============================================ the schedule, as pure logic
  s.check('startup is due on every launch',
    autoBackup.isDue({ frequency: 'startup', latestAt: at(2026, 8, 20), now: new Date(2026, 7, 20, 23) }) === true);

  s.check('a frequency that has never run is due',
    autoBackup.isDue({ frequency: 'daily', latestAt: null }) === true);
  s.check('weekly that has never run is due',
    autoBackup.isDue({ frequency: 'weekly', latestAt: null }) === true);

  /* Calendar days, not 24-hour windows. This is the case that decides whether
     the second shift of a two-day stretch gets a backup. */
  s.check('daily is NOT due twice on the same local day',
    autoBackup.isDue({ frequency: 'daily', latestAt: at(2026, 8, 20, 9), now: new Date(2026, 7, 20, 23) }) === false);
  s.check('daily IS due on the next local day, even 23 hours later',
    autoBackup.isDue({ frequency: 'daily', latestAt: at(2026, 8, 20, 9), now: new Date(2026, 7, 21, 8) }) === true);

  s.check('weekly is not due after six days',
    autoBackup.isDue({ frequency: 'weekly', latestAt: at(2026, 8, 14), now: new Date(2026, 7, 20) }) === false);
  s.check('weekly is due on the seventh day',
    autoBackup.isDue({ frequency: 'weekly', latestAt: at(2026, 8, 13), now: new Date(2026, 7, 20) }) === true);
  s.check('weekly is due long after',
    autoBackup.isDue({ frequency: 'weekly', latestAt: at(2026, 6, 1), now: new Date(2026, 7, 20) }) === true);

  // ============================================== settings, read defensively
  const app = new TestApp('mmh-autobackup');
  try {
    await app.bootstrapAdmin();
    const setSetting = (key, value) => app.db.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value, new Date().toISOString());

    const defaults = autoBackup.readSettings(app.db);
    s.check('an installation that has never touched Settings backs up on startup',
      defaults.enabled === true && defaults.frequency === 'startup' && defaults.keep === 10,
      JSON.stringify(defaults));

    setSetting('backup.frequency', 'nonsense');
    setSetting('backup.keep', '-4');
    const nonsense = autoBackup.readSettings(app.db);
    s.check('a frequency the product does not have falls back rather than skipping backups',
      nonsense.frequency === 'startup', String(nonsense.frequency));
    s.check('an impossible retention count falls back to the default',
      nonsense.keep === 10, String(nonsense.keep));

    setSetting('backup.keep', '99999');
    s.check('an absurd retention count is capped',
      autoBackup.readSettings(app.db).keep <= 200, String(autoBackup.readSettings(app.db).keep));

    // ======================================== the real service, real files
    const backup = backupFactory.build({
      paths: app.paths,
      getDb: () => app.db,
      log: () => {},
    });
    const ctx = app.ctx();

    setSetting('backup.auto_enabled', 'false');
    setSetting('backup.frequency', 'startup');
    setSetting('backup.keep', '10');
    const skipped = await autoBackup.runAtStartup({ db: app.db, backup, ctx });
    s.check('turning Automatic Backup off actually stops it',
      skipped.ran === false && skipped.reason === 'disabled', JSON.stringify(skipped));
    s.check('and no file was written',
      fs.readdirSync(app.paths.backups).filter((f) => f.endsWith('.mmhbackup')).length === 0);

    setSetting('backup.auto_enabled', 'true');
    const first = await autoBackup.runAtStartup({ db: app.db, backup, ctx });
    s.check('turning it on creates a backup at startup', first.ran === true, JSON.stringify(first));
    s.check('the file is on disk',
      fs.existsSync(path.join(app.paths.backups, first.created)), String(first.created));
    s.check('and it is identifiable as automatic',
      /-auto\.mmhbackup$/.test(first.created), String(first.created));

    /* A manual backup must be indistinguishable in quality and distinguishable
       in name — retention depends on telling them apart. */
    const manual = await backup.create(ctx, { label: 'manual' });
    s.check('a manual backup is named differently',
      !/-auto\.mmhbackup$/.test(manual.name), manual.name);

    // -------------------------------------------------- daily, not yet due
    setSetting('backup.frequency', 'daily');
    const sameDay = await autoBackup.runAtStartup({ db: app.db, backup, ctx });
    s.check('daily does not back up a second time on the same day',
      sameDay.ran === false && sameDay.reason === 'not-due', JSON.stringify(sameDay));

    // ------------------------------------------------------ daily, now due
    /* Age the automatic backup by two days by moving its mtime — the service
       reads the filesystem, so this is the honest way to simulate yesterday. */
    const autoFile = path.join(app.paths.backups, first.created);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
    fs.utimesSync(autoFile, twoDaysAgo, twoDaysAgo);
    const nextDay = await autoBackup.runAtStartup({ db: app.db, backup, ctx });
    s.check('daily backs up again once the day has changed',
      nextDay.ran === true, JSON.stringify(nextDay));

    // ----------------------------------------------------- weekly boundary
    setSetting('backup.frequency', 'weekly');
    const weeklyNotDue = await autoBackup.runAtStartup({ db: app.db, backup, ctx });
    s.check('weekly does not back up two days after the last one',
      weeklyNotDue.ran === false, JSON.stringify(weeklyNotDue));

    // ------------------------------------- retention keeps manual backups
    setSetting('backup.frequency', 'startup');
    setSetting('backup.keep', '2');
    for (let i = 0; i < 3; i++) {
      /* Distinct timestamps, since the name carries the second. */
      await new Promise((r) => setTimeout(r, 1100));
      await autoBackup.runAtStartup({ db: app.db, backup, ctx });
    }
    const remaining = fs.readdirSync(app.paths.backups).filter((f) => f.endsWith('.mmhbackup'));
    const automatic = remaining.filter((f) => /-auto\.mmhbackup$/.test(f));
    s.check('retention keeps the configured number of automatic backups',
      automatic.length <= 2, `${automatic.length} automatic backups remain`);
    s.check('and NEVER removes a manual one',
      remaining.includes(manual.name), remaining.join(', '));

    // --------------------------------- a failure must not stop the operator
    const broken = {
      list: () => { throw new Error('cannot read the backup folder'); },
      create: async () => { throw new Error('disk full'); },
      prune: () => { throw new Error('cannot prune'); },
    };
    let threw = null;
    let outcome = null;
    try { outcome = await autoBackup.runAtStartup({ db: app.db, backup: broken, ctx }); }
    catch (err) { threw = err; }
    s.check('a backup failure at startup does not throw',
      threw === null, String(threw && threw.message));
    s.check('and is reported as a failure rather than silently claimed as success',
      outcome && outcome.ran === false && outcome.reason === 'failed', JSON.stringify(outcome));

    /* The live database must be untouched by any of this. */
    const health = require('../../src/main/database/connection').checkHealth(app.db, { deep: true });
    s.check('the live database is still healthy after all of it',
      health.healthy === true, JSON.stringify(health.problems));
    s.check('and still holds the administrator',
      app.db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'ADMIN'").get().n === 1);
  } finally {
    app.close();
  }

  return s.finish();
};
