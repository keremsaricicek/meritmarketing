'use strict';
/* The IPC boundary.
 *
 * Every privileged call from the renderer arrives here and goes through the
 * same fixed sequence before any service runs:
 *
 *   1. the channel is known and documented in the security surface
 *   2. the SENDER is the application's own window, not some other frame
 *   3. a session exists when the surface says one is required
 *   4. the payload validates against its schema (unknown fields rejected)
 *   5. the service enforces capability, record scope and guest protection
 *   6. the result is a sanitized DTO; errors lose their stack and SQL
 *
 * The registry refuses to start if a handler has no surface entry, or a surface
 * entry has no handler. That is the mechanism that makes "you cannot add a verb
 * without a security decision" true rather than aspirational.
 */

const { SURFACE } = require('../../shared/contracts/ipc-surface');
const { SCHEMAS } = require('../../shared/validation/schemas');
const { AppError, CODES, ok, fail, authRequired, validation } = require('../../shared/errors');

/* A renderer compromised by hostile guest data must not be able to reach a
   privileged channel by creating a frame or navigating away. The sender's frame
   must be the top frame of a window we created, and its URL must be the one we
   loaded. */
function makeSenderValidator({ getTrustedWindow, expectedOrigin }) {
  return function isTrustedSender(event) {
    try {
      const win = getTrustedWindow();
      if (!win || win.isDestroyed()) return false;
      if (!event.sender || event.sender !== win.webContents) return false;
      /* senderFrame is undefined in some test doubles; when present it must be
         the main frame, never a child frame or a detached one. */
      const frame = event.senderFrame;
      if (frame) {
        if (frame.parent) return false;
        const url = String(frame.url || '');
        if (expectedOrigin && !url.startsWith(expectedOrigin)) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  };
}

function formatZodError(error) {
  const first = error.issues && error.issues[0];
  if (!first) return validation('That request was not valid.');
  const field = Array.isArray(first.path) && first.path.length ? String(first.path[0]) : undefined;
  /* Zod's own wording ("Unrecognized key(s) in object") is developer-facing.
     The user gets something plain; the detail goes to diagnostics. */
  const message = first.code === 'unrecognized_keys'
    ? 'That request contained unexpected fields.'
    : 'Some of the information provided is not valid.';
  return validation(message, field, undefined);
}

/**
 * @param {object} deps
 *   ipcMain           Electron's ipcMain (or a double in tests)
 *   handlers          { [channel]: (ctx, payload) => result }
 *   getContext        () => ctx  — db, sessions, audit, paths
 *   isTrustedSender   (event) => boolean
 *   log               (level, message, meta) => void
 */
function registerAll({ ipcMain, handlers, getContext, isTrustedSender, log = () => {} }) {
  const documented = Object.keys(SURFACE).sort();
  const implemented = Object.keys(handlers).sort();

  const undocumented = implemented.filter((c) => !documented.includes(c));
  if (undocumented.length) {
    throw new Error(`IPC channels without a security-surface entry: ${undocumented.join(', ')}`);
  }
  const unimplemented = documented.filter((c) => !implemented.includes(c));
  if (unimplemented.length) {
    throw new Error(`Security-surface entries with no handler: ${unimplemented.join(', ')}`);
  }
  const unvalidated = documented.filter((c) => !SCHEMAS[c]);
  if (unvalidated.length) {
    throw new Error(`IPC channels without a payload schema: ${unvalidated.join(', ')}`);
  }

  for (const channel of documented) {
    const spec = SURFACE[channel];
    const schema = SCHEMAS[channel];
    const handler = handlers[channel];

    ipcMain.handle(channel, async (event, rawPayload) => {
      try {
        if (isTrustedSender && !isTrustedSender(event)) {
          log('warn', 'ipc.untrusted-sender', { channel });
          throw new AppError(CODES.FORBIDDEN, 'This request could not be verified.');
        }

        const ctx = getContext();

        if (spec.auth === 'required' && !ctx.sessions.get()) throw authRequired();

        const parsed = schema.safeParse(rawPayload === undefined || rawPayload === null ? {} : rawPayload);
        if (!parsed.success) {
          log('info', 'ipc.invalid-payload', { channel, issues: parsed.error.issues.slice(0, 3) });
          throw formatZodError(parsed.error);
        }

        const result = await handler(ctx, parsed.data);
        return ok(result === undefined ? null : result);
      } catch (err) {
        if (err instanceof AppError) {
          /* Expected refusals are the system working. Only the unexpected ones
             deserve a stack in the log. */
          log('info', 'ipc.refused', { channel, code: err.code, internal: err.internal });
          return fail(err);
        }
        log('error', 'ipc.failed', { channel, message: err.message, stack: err.stack });
        return fail(new AppError(CODES.INTERNAL, 'An unexpected error occurred.'));
      }
    });
  }

  return { channels: documented };
}

module.exports = { registerAll, makeSenderValidator, formatZodError };
