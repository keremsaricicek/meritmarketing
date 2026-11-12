#!/usr/bin/env node
'use strict';
/* FORGOT THE ADMINISTRATOR PASSWORD.
 *
 * There is no recovery back door inside the application, and there should not
 * be: a door that lets the owner in lets in whoever finds it. But the owner of
 * the machine owns the database file, and anybody who can read that file can
 * already do what this script does. So this is not a weakening of the model —
 * it is the offline, physical-access recovery path, stated out loud instead of
 * left as folklore.
 *
 * What it does: sets a new Argon2id hash for ONE named user, in place. It
 * touches nothing else — no guest, no reservation, no note, no photo. It
 * refuses to invent a user, refuses a weak password (the same strength rule the
 * application enforces), and writes an audit row so the reset is visible in the
 * log afterwards rather than being silent.
 *
 * It is NOT shipped inside the installed application: forge.config.js excludes
 * the whole scripts/ directory from the package.
 *
 *   npm run reset-password -- --list
 *   npm run reset-password -- --user owner --password "a-new-long-password"
 *
 * With no --db it uses the real Windows data folder:
 *   %APPDATA%\Merit Marketing Hub\data\merit-marketing.sqlite3
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const passwords = require(path.join(ROOT, 'src', 'main', 'auth', 'passwords'));
const { Database } = require(path.join(ROOT, 'src', 'main', 'database', 'driver'));

const PRODUCT = 'Merit Marketing Hub';

function defaultDatabase() {
  /* The same location Electron's app.getPath('userData') resolves to, worked
     out without Electron so this can run as a plain script. */
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, PRODUCT, 'data', 'merit-marketing.sqlite3');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', PRODUCT, 'data', 'merit-marketing.sqlite3');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    PRODUCT, 'data', 'merit-marketing.sqlite3');
}

function parseArgs(argv) {
  const out = { list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') out.list = true;
    else if (arg === '--user') out.user = argv[++i];
    else if (arg === '--password') out.password = argv[++i];
    else if (arg === '--db') out.db = argv[++i];
  }
  return out;
}

function fail(message, hint) {
  console.error(`\nSTOPPED — ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const file = args.db ? path.resolve(args.db) : defaultDatabase();

  console.log(`\nMerit Marketing Hub — password reset`);
  console.log(`  database: ${file}`);

  if (!fs.existsSync(file)) {
    fail('that database file does not exist.',
      'Close the application, check the path, or pass --db "C:\\path\\to\\merit-marketing.sqlite3".');
  }

  /* Opened directly rather than through the application's connection module:
     that one runs migrations, and a recovery tool must not change the schema of
     a database it was called to rescue. */
  const db = new Database(file);

  const users = db.prepare(
    'SELECT id, username, role, full_name, active FROM users ORDER BY id').all();

  if (args.list || (!args.user && !args.password)) {
    console.log('\n  id  role      active  username');
    for (const u of users) {
      console.log(`  ${String(u.id).padEnd(3)} ${String(u.role).padEnd(9)} ${u.active ? 'yes   ' : 'no    '} ${u.username}`);
    }
    console.log('\nTo set a new password:');
    console.log('  npm run reset-password -- --user <username> --password "<new password>"\n');
    db.close();
    return;
  }

  if (!args.user) fail('no --user was given.', 'Run with --list to see the usernames.');
  if (!args.password) fail('no --password was given.', 'Pass --password "<new password>".');

  const user = users.find((u) => u.username === args.user);
  if (!user) {
    fail(`there is no user called "${args.user}".`,
      'Run with --list to see the usernames. No account is created by this script.');
  }

  /* The same rule the application applies, so a password set here is one the
     application would have accepted. */
  const strength = passwords.validateStrength(args.password, { username: user.username });
  if (strength && strength.ok === false) {
    fail(strength.message || 'that password is too weak.', 'Use at least 10 characters.');
  }

  const hash = await passwords.hash(args.password);
  const now = new Date().toISOString();

  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hash, now, user.id);

  /* Visible afterwards. A reset that leaves no trace is indistinguishable from
     an intrusion, which is precisely the thing the audit log exists to tell
     apart. */
  try {
    db.prepare(`INSERT INTO audit_log (action, entity_type, entity_id, actor_user_id, actor_username, description, created_at)
      VALUES ('PASSWORD_RESET_OFFLINE', 'user', ?, ?, ?, ?, ?)`)
      .run(user.id, user.id, user.username,
        'Password reset offline with scripts/recovery/reset-password.js', now);
  } catch (err) {
    console.warn(`  (the audit row could not be written: ${err.message})`);
  }

  if (user.active === 0) {
    console.log(`\n  NOTE: "${user.username}" is marked inactive and still cannot sign in.`);
    console.log('  Another ADMIN must reactivate the account in Settings → Users.');
  }

  db.close();
  console.log(`\nDONE — "${user.username}" now signs in with the password you supplied.`);
  console.log('Change it inside the application afterwards if anyone else saw it.\n');
})().catch((err) => {
  console.error(`\nSTOPPED — ${err.message}\n`);
  process.exit(1);
});
