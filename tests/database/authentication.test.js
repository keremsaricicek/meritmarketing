'use strict';
/* First run, login hardening, and the guarantee that no password is ever stored.
 *
 * The production application ships with no accounts at all, so the first-run
 * path is not a nicety — it is the only way anybody ever gets in. If it breaks,
 * a fresh install is a brick.
 */

const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const auth = require('../../src/main/services/auth-service');
const passwords = require('../../src/main/auth/passwords');

const PW = 'quiet-oxblood-lantern';

module.exports = async function () {
  const s = new Suite('database/authentication');
  const app = new TestApp('mmh-auth');

  try {
    // ------------------------------------------------------------ first run
    s.check('a brand-new database needs setup', auth.needsSetup(app.db) === true);
    s.check('a brand-new database has no users at all',
      app.db.prepare('SELECT COUNT(*) n FROM users').get().n === 0);

    const created = await auth.setup(app.db,
      { username: 'Admin', password: PW, passwordConfirm: PW, fullName: 'Owner' }, app.ctx());
    s.check('setup creates the first administrator', created.id > 0, JSON.stringify(created));
    s.check('the username is normalised to lower case', created.username === 'admin', created.username);
    s.check('setup is recorded in the audit log',
      app.auditLog.some((e) => e.action === 'SETUP_COMPLETE'), JSON.stringify(app.auditLog));
    s.check('the app no longer asks for setup', auth.needsSetup(app.db) === false);

    // Setup must be closed forever, or it is an unauthenticated admin-creation verb.
    let secondSetup = null;
    try {
      await auth.setup(app.db, { username: 'sneak', password: 'another-long-pw', passwordConfirm: 'another-long-pw' }, app.ctx());
    } catch (err) { secondSetup = err.code; }
    s.check('setup refuses once an account exists', secondSetup === 'FORBIDDEN', String(secondSetup));

    // ------------------------------------------------- password never stored
    const row = app.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(created.id);
    s.check('the stored credential is an Argon2id hash',
      row.password_hash.startsWith('$argon2id$'), row.password_hash.slice(0, 24));
    s.check('the plaintext password is nowhere in the stored hash',
      !row.password_hash.includes(PW), 'plaintext leaked into the hash column');

    const dump = JSON.stringify(app.db.prepare('SELECT * FROM users').all());
    s.check('the plaintext password is nowhere in the users table', !dump.includes(PW));
    const auditDump = JSON.stringify(app.db.prepare('SELECT * FROM audit_log').all());
    s.check('the plaintext password is nowhere in the audit log', !auditDump.includes(PW));

    // ------------------------------------------------------ password policy
    const weak = passwords.validateStrength('short');
    s.check('a too-short password is refused', weak.ok === false, JSON.stringify(weak));
    s.check('an obvious password is refused', passwords.validateStrength('password1').ok === false);
    s.check('a password containing the username is refused',
      passwords.validateStrength('marketing-hub-1', { username: 'marketing' }).ok === false);
    s.check('a reasonable passphrase is accepted',
      passwords.validateStrength('quiet-oxblood-lantern').ok === true);

    // ------------------------------------------------------------ login
    let wrong = null;
    try { await auth.login(app.db, { username: 'admin', password: 'nope' }, app.ctx()); }
    catch (err) { wrong = err; }
    s.check('a wrong password is refused', wrong && wrong.code === 'VALIDATION', String(wrong && wrong.code));
    s.check('the refusal does not reveal whether the user exists',
      wrong.message === 'Incorrect username or password.', wrong.message);

    let unknown = null;
    try { await auth.login(app.db, { username: 'nobody', password: 'nope' }, app.ctx()); }
    catch (err) { unknown = err; }
    s.check('an unknown user gets the identical message (no username oracle)',
      unknown.message === wrong.message, `${unknown.message} vs ${wrong.message}`);

    const session = await auth.login(app.db, { username: 'admin', password: PW }, app.ctx());
    s.check('the correct password signs the user in', session && session.role === 'ADMIN', JSON.stringify(session));
    s.check('last_login_at is recorded',
      !!app.db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(created.id).last_login_at);

    // What the renderer is allowed to see about the session.
    const wire = app.sessions.toWire(['customers.delete']);
    s.check('the session sent to the renderer has no password hash',
      !JSON.stringify(wire).toLowerCase().includes('argon2'), JSON.stringify(wire));
    s.check('the session sent to the renderer carries role and capabilities',
      wire.role === 'ADMIN' && wire.capabilities['customers.delete'] === true, JSON.stringify(wire));

    // ---------------------------------------------------------- throttling
    app.sessions.end();
    let limited = null;
    for (let i = 0; i < auth.MAX_ATTEMPTS + 1; i++) {
      try { await auth.login(app.db, { username: 'admin', password: 'bad-guess' }, app.ctx()); }
      catch (err) { limited = err; }
    }
    s.check('repeated failures eventually rate-limit the account',
      limited && limited.code === 'RATE_LIMITED', `${limited && limited.code}: ${limited && limited.message}`);
    s.check('the lock is temporary, not permanent',
      /minute/i.test(limited.message), limited.message);

    const locked = app.db.prepare('SELECT locked_until FROM users WHERE id = ?').get(created.id);
    s.check('the lock has an expiry timestamp', !!locked.locked_until, String(locked.locked_until));

    // Clearing the lock lets the real owner back in — no support call required.
    app.db.prepare('UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = ?').run(created.id);
    const recovered = await auth.login(app.db, { username: 'admin', password: PW }, app.ctx());
    s.check('the account works again once the lock expires', recovered.role === 'ADMIN');

    // ------------------------------------------------------ disabled account
    const other = await app.createMarketingUser({ username: 'sena', profileName: 'SENA NUR AKMUT' });
    app.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(other.userId);
    let disabled = null;
    try { await auth.login(app.db, { username: 'sena', password: other.password }, app.ctx()); }
    catch (err) { disabled = err; }
    s.check('a disabled account cannot sign in', disabled && disabled.code === 'FORBIDDEN', String(disabled && disabled.code));

    // ------------------------------------------------------ password change
    await auth.login(app.db, { username: 'admin', password: PW }, app.ctx());
    let badCurrent = null;
    try {
      await auth.changePassword(app.db,
        { currentPassword: 'not-it', newPassword: 'graphite-evening-ledger', newPasswordConfirm: 'graphite-evening-ledger' },
        app.ctx());
    } catch (err) { badCurrent = err; }
    s.check('changing a password requires the current one',
      badCurrent && badCurrent.field === 'currentPassword', JSON.stringify(badCurrent && badCurrent.field));

    let mismatch = null;
    try {
      await auth.changePassword(app.db,
        { currentPassword: PW, newPassword: 'graphite-evening-ledger', newPasswordConfirm: 'different-one' }, app.ctx());
    } catch (err) { mismatch = err; }
    s.check('a mismatched confirmation is refused', mismatch && mismatch.code === 'VALIDATION');

    let reuse = null;
    try {
      await auth.changePassword(app.db,
        { currentPassword: PW, newPassword: PW, newPasswordConfirm: PW }, app.ctx());
    } catch (err) { reuse = err; }
    s.check('reusing the same password is refused', reuse && reuse.code === 'VALIDATION', String(reuse && reuse.message));

    const changed = await auth.changePassword(app.db,
      { currentPassword: PW, newPassword: 'graphite-evening-ledger', newPasswordConfirm: 'graphite-evening-ledger' }, app.ctx());
    s.check('a valid password change succeeds', changed.ok === true);
    app.sessions.end();
    const afterChange = await auth.login(app.db, { username: 'admin', password: 'graphite-evening-ledger' }, app.ctx());
    s.check('the new password works', afterChange.role === 'ADMIN');
    let oldPw = null;
    try { app.sessions.end(); await auth.login(app.db, { username: 'admin', password: PW }, app.ctx()); }
    catch (err) { oldPw = err; }
    s.check('the old password stops working', !!oldPw, 'old password still accepted');

    // ------------------------------------------------------ session hygiene
    app.sessions.end();
    s.check('logout clears the session', app.sessions.get() === null);
    s.check('a cleared session has no capabilities', app.sessions.can('customers.read') === false);

    const short = new (require('../../src/main/auth/session').SessionManager)({ idleTimeoutMs: 1 });
    short.start({ id: 1, username: 'x', role: 'ADMIN', profile_id: null });
    await new Promise((r) => setTimeout(r, 20));
    s.check('an idle session expires', short.get() === null);
  } finally {
    app.close();
  }

  return s.finish();
};
