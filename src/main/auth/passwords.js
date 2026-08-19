'use strict';
/* Password hashing — Argon2id.
 *
 * Chosen over bcrypt/scrypt because it is the current OWASP first
 * recommendation and is memory-hard in a way that blunts GPU attack on a stolen
 * .sqlite3 file. @node-rs/argon2 is a Rust N-API addon: N-API is ABI-stable, so
 * it survives Electron packaging without an electron-rebuild step, which is
 * exactly the fragility that makes native crypto painful in Electron.
 *
 * Parameters follow the OWASP guidance for Argon2id (19 MiB, t=2, p=1). The
 * cost is deliberately modest: this runs on an office desktop during login, and
 * a parameter set that takes two seconds gets removed by whoever is on support
 * duty. The parameters are recorded inside the hash string, so they can be
 * raised later and existing users are rehashed on their next successful login.
 */

const argon2 = require('@node-rs/argon2');

const OPTIONS = Object.freeze({
  algorithm: 2,          // Argon2id
  memoryCost: 19456,     // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

const MIN_LENGTH = 10;
const MAX_LENGTH = 200;

/* A length floor plus a "not obviously terrible" check. Deliberately no
   composition rules: forcing a symbol and a digit produces Password1! and
   measurably worse passwords, and this is a local desktop app behind a Windows
   login, not an internet-facing service. */
const OBVIOUS = new Set([
  'password', 'password1', 'passw0rd', '1234567890', 'qwertyuiop',
  'letmein123', 'admin12345', 'merit12345', 'meritmarketing',
]);

function validateStrength(password, { username } = {}) {
  const value = String(password || '');
  if (value.length < MIN_LENGTH) {
    return { ok: false, message: `Password must be at least ${MIN_LENGTH} characters.` };
  }
  if (value.length > MAX_LENGTH) {
    return { ok: false, message: `Password must be at most ${MAX_LENGTH} characters.` };
  }
  if (OBVIOUS.has(value.toLowerCase())) {
    return { ok: false, message: 'That password is too easy to guess. Please choose another.' };
  }
  if (username && value.toLowerCase().includes(String(username).toLowerCase()) && String(username).length >= 4) {
    return { ok: false, message: 'Password must not contain the username.' };
  }
  return { ok: true };
}

async function hash(password) {
  return argon2.hash(String(password), OPTIONS);
}

/* Constant-time comparison lives inside the library. A thrown error here means
   a malformed or truncated hash, which must read as "wrong password" rather
   than crashing the login handler — but it is worth logging. */
async function verify(storedHash, password) {
  try {
    return await argon2.verify(String(storedHash), String(password));
  } catch (_) {
    return false;
  }
}

/** True when a stored hash was made with weaker parameters than we now use. */
function needsRehash(storedHash) {
  try {
    const m = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(String(storedHash));
    if (!m) return true;
    const [, memory, time, parallel] = m.map(Number);
    return memory < OPTIONS.memoryCost || time < OPTIONS.timeCost || parallel < OPTIONS.parallelism;
  } catch (_) {
    return true;
  }
}

module.exports = { hash, verify, needsRehash, validateStrength, OPTIONS, MIN_LENGTH };
