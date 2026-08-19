'use strict';
/* Local structured diagnostics. Nothing leaves the machine.
 *
 * There is no telemetry and no upload. These files exist so that when an
 * operator says "it did something strange on Tuesday", there is something to
 * read. They rotate, because a log that fills a disk turns a minor bug into an
 * outage.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5;

/* Values that must never reach a log file even by accident. Redaction is by
   key name because that is what survives refactoring: a field called `password`
   is a password wherever it turns up. */
const SENSITIVE = /^(password|passwordConfirm|newPassword|newPasswordConfirm|currentPassword|password_hash|token|secret|apiKey)$/i;

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE.test(k)) out[k] = '[redacted]';
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

class Logger {
  constructor({ dir, file = 'merit.log', console: toConsole = false } = {}) {
    this.dir = dir;
    this.file = dir ? path.join(dir, file) : null;
    this.toConsole = toConsole;
    this.context = {};
  }

  /** Stamped onto every entry: app version, commit, schema version. */
  setContext(context) { this.context = { ...this.context, ...context }; }

  rotate() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      if (fs.statSync(this.file).size < MAX_BYTES) return;
      for (let i = MAX_FILES - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(this.file, `${this.file}.1`);
      const oldest = `${this.file}.${MAX_FILES + 1}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    } catch (_) { /* logging must never be the thing that breaks */ }
  }

  write(level, message, meta) {
    const entry = {
      t: new Date().toISOString(),
      level,
      msg: message,
      ...this.context,
      ...(meta ? { meta: redact(meta) } : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (this.toConsole) process.stdout.write(line);
    if (!this.file) return;
    try {
      this.rotate();
      fs.appendFileSync(this.file, line);
    } catch (_) { /* see above */ }
  }

  info(message, meta) { this.write('info', message, meta); }
  warn(message, meta) { this.write('warn', message, meta); }
  error(message, meta) { this.write('error', message, meta); }

  /** The signature the IPC registry expects. */
  asFunction() {
    return (level, message, meta) => this.write(level, message, meta);
  }
}

module.exports = { Logger, redact };
