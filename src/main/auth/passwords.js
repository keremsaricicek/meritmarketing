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

/* The owner explicitly wants staff to be able to choose ANY password,
   including short ones such as "1234" or "0000". The only rules are: not
   empty, and not absurdly long (Argon2 input cap). Brute force against the
   sign-in screen is limited by account lockout (see lockout handling in the
   auth service); hashing stays Argon2id. */
const MIN_LENGTH = 1;
const MAX_LENGTH = 200;

function validateStrength(password) {
  const value = password == null ? '' : String(password);
  if (value.length < MIN_LENGTH) {
    return { ok: false, message: 'Password must not be empty.' };
  }
  if (value.length > MAX_LENGTH) {
    return { ok: false, message: `Password must be at most ${MAX_LENGTH} characters.` };
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

module.exports = { hash, verify, needsRehash, validateStrength, OPTIONS, MIN_LENGTH, MAX_LENGTH };
