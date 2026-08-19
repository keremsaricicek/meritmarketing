'use strict';
/* The application error model.
 *
 * Every privileged operation returns { ok:true, data } or { ok:false, error }.
 * The renderer never sees a stack trace, a SQL string or a filesystem path —
 * those go to diagnostics. What crosses the bridge is a stable code, a message
 * safe to show a user, and optionally the field a form should highlight.
 */

const CODES = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  PROTECTED_GUEST: 'PROTECTED_GUEST',
  DATABASE_ERROR: 'DATABASE_ERROR',
  BACKUP_INVALID: 'BACKUP_INVALID',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  UPDATE_FAILED: 'UPDATE_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
});

/* The one user-facing protection message. Deliberately says nothing about who
   owns the guest or when the window expires — that would turn a refusal into a
   disclosure. Kept as a constant so no caller can drift from it. */
const PROTECTED_GUEST_MESSAGE = 'Guest protection period has not expired.';
const OUT_OF_SCOPE_MESSAGE = 'You do not have access to this record.';

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = CODES[code] ? code : CODES.INTERNAL;
    this.field = options.field;
    this.details = options.details;
    /* Anything attached here is for the log only and never crosses the bridge. */
    this.internal = options.internal;
  }

  toWire() {
    const error = { code: this.code, message: this.message };
    if (this.field) error.field = this.field;
    if (this.details !== undefined) error.details = this.details;
    return error;
  }
}

const authRequired = (m = 'Not signed in.') => new AppError(CODES.AUTH_REQUIRED, m);
const forbidden = (m = 'You do not have permission to perform this action.') => new AppError(CODES.FORBIDDEN, m);
const outOfScope = () => new AppError(CODES.FORBIDDEN, OUT_OF_SCOPE_MESSAGE);
const notFound = (m = 'Not found.') => new AppError(CODES.NOT_FOUND, m);
const validation = (m, field, details) => new AppError(CODES.VALIDATION, m, { field, details });
const conflict = (m, details) => new AppError(CODES.CONFLICT, m, { details });
const protectedGuest = () => new AppError(CODES.PROTECTED_GUEST, PROTECTED_GUEST_MESSAGE);

const ok = (data) => ({ ok: true, data });
const fail = (error) => ({
  ok: false,
  error: error instanceof AppError
    ? error.toWire()
    : { code: CODES.INTERNAL, message: 'An unexpected error occurred.' },
});

module.exports = {
  CODES, AppError, PROTECTED_GUEST_MESSAGE, OUT_OF_SCOPE_MESSAGE,
  authRequired, forbidden, outOfScope, notFound, validation, conflict, protectedGuest,
  ok, fail,
};
