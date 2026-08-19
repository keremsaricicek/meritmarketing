'use strict';
/* Authentication: first run, login, logout, password change.
 *
 * There is no default account and no recovery backdoor. A brand-new install has
 * an empty users table, and the only way in is to create the first ADMIN. That
 * is why `setup` refuses once any user exists — otherwise it would be exactly
 * the backdoor it was written to avoid.
 */

const passwords = require('../auth/passwords');
const { nowIso } = require('../../shared/contracts/dates');
const { AppError, CODES, validation, authRequired, forbidden } = require('../../shared/errors');

/* Login throttling. Backoff is per account and time-based rather than a
   permanent lock: a locked-out manager on a Saturday night is an outage, and an
   attacker slowed to a handful of guesses per minute has already lost. */
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

function usersExist(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

function adminExists(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND active = 1").get().n > 0;
}

/** True when the app should show first-run setup instead of the login screen. */
function needsSetup(db) {
  return !adminExists(db);
}

async function setup(db, { username, password, passwordConfirm, fullName }, { audit }) {
  /* Once anybody exists this is closed forever. A "setup" verb that still works
     on a populated database is an unauthenticated admin-creation endpoint. */
  if (usersExist(db)) {
    throw forbidden('This installation has already been set up.');
  }
  const name = String(username || '').trim().toLowerCase();
  if (name.length < 3) throw validation('Username must be at least 3 characters.', 'username');
  if (!/^[a-z0-9._-]+$/.test(name)) {
    throw validation('Username may contain only letters, numbers, dot, dash and underscore.', 'username');
  }
  if (password !== passwordConfirm) throw validation('The passwords do not match.', 'passwordConfirm');
  const strength = passwords.validateStrength(password, { username: name });
  if (!strength.ok) throw validation(strength.message, 'password');

  const hash = await passwords.hash(password);
  const now = nowIso();
  const id = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, active, created_at, updated_at)
    VALUES (?, ?, 'ADMIN', ?, 1, ?, ?)`)
    .run(name, hash, String(fullName || '').trim() || null, now, now).lastInsertRowid;

  audit({
    action: 'SETUP_COMPLETE', entity_type: 'user', entity_id: id,
    actor_user_id: id, actor_username: name,
    description: `First administrator account created: ${name}`,
  });
  return { id, username: name };
}

function lockRemainingMs(user) {
  if (!user.locked_until) return 0;
  const until = Date.parse(user.locked_until);
  return Number.isNaN(until) ? 0 : Math.max(0, until - Date.now());
}

async function login(db, { username, password }, { audit, sessions }) {
  const name = String(username || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name);

  /* One message for "no such user" and "wrong password". Distinguishing them
     turns the login form into a username oracle. The Argon2 verify below runs
     only when the user exists, so timing differs slightly; that is an accepted
     trade against burning 19 MiB per bogus request. */
  const invalid = () => validation('Incorrect username or password.', 'password');

  if (!user) {
    audit({ action: 'LOGIN_FAILED', entity_type: 'user', actor_username: name,
      description: `Failed sign-in for unknown user "${name}"` });
    throw invalid();
  }

  const remaining = lockRemainingMs(user);
  if (remaining > 0) {
    throw new AppError(CODES.RATE_LIMITED,
      `Too many failed attempts. Try again in ${Math.ceil(remaining / 60000)} minute(s).`);
  }

  if (!user.active) {
    audit({ action: 'LOGIN_BLOCKED', entity_type: 'user', entity_id: user.id, actor_username: name,
      description: `Sign-in refused for disabled account "${name}"` });
    throw forbidden('This account has been disabled.');
  }

  const okPassword = await passwords.verify(user.password_hash, password);
  if (!okPassword) {
    const failed = (user.failed_logins || 0) + 1;
    const lockUntil = failed >= MAX_ATTEMPTS
      ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString()
      : null;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
      .run(failed >= MAX_ATTEMPTS ? 0 : failed, lockUntil, user.id);
    audit({ action: 'LOGIN_FAILED', entity_type: 'user', entity_id: user.id, actor_username: name,
      description: `Failed sign-in for "${name}" (attempt ${failed})` });
    throw invalid();
  }

  /* Parameters can be raised later; existing users are upgraded transparently
     the next time they prove they know the password. */
  if (passwords.needsRehash(user.password_hash)) {
    const fresh = await passwords.hash(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(fresh, user.id);
  }

  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
    .run(nowIso(), user.id);

  const session = sessions.start(user);
  audit({ action: 'LOGIN', entity_type: 'user', entity_id: user.id,
    actor_user_id: user.id, actor_username: user.username,
    description: `${user.username} signed in` });
  return session;
}

function logout({ audit, sessions }) {
  const s = sessions.get();
  if (s) {
    audit({ action: 'LOGOUT', entity_type: 'user', entity_id: s.id,
      actor_user_id: s.id, actor_username: s.username, description: `${s.username} signed out` });
  }
  sessions.end();
  return { ok: true };
}

async function changePassword(db, { currentPassword, newPassword, newPasswordConfirm }, { audit, sessions }) {
  const s = sessions.get();
  if (!s) throw authRequired();

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.id);
  if (!user) throw authRequired();

  /* Proving knowledge of the current password is what stops an unattended
     unlocked workstation from becoming a permanent account takeover. */
  const okCurrent = await passwords.verify(user.password_hash, currentPassword);
  if (!okCurrent) throw validation('Your current password is not correct.', 'currentPassword');

  if (newPassword !== newPasswordConfirm) throw validation('The new passwords do not match.', 'newPasswordConfirm');
  const strength = passwords.validateStrength(newPassword, { username: user.username });
  if (!strength.ok) throw validation(strength.message, 'newPassword');
  if (await passwords.verify(user.password_hash, newPassword)) {
    throw validation('The new password must be different from the current one.', 'newPassword');
  }

  const hash = await passwords.hash(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, nowIso(), user.id);
  audit({ action: 'PASSWORD_CHANGE', entity_type: 'user', entity_id: user.id,
    actor_user_id: user.id, actor_username: user.username,
    description: `${user.username} changed their password` });
  return { ok: true };
}

module.exports = { needsSetup, usersExist, adminExists, setup, login, logout, changePassword, MAX_ATTEMPTS, LOCK_MINUTES };
