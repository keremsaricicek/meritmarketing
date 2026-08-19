'use strict';
/* IPC SURFACE ENFORCEMENT.
 *
 * The browser build proved its API matrix by calling window.api. That object is
 * gone; the boundary is now IPC. This suite drives the REAL registry with a
 * stand-in ipcMain, so every call goes through the same sequence a renderer's
 * call would: sender validation, session check, schema parse, service.
 *
 * The value is entirely in catching a FUTURE mistake — a new channel added
 * without a guard, or a matrix row that claims a check the handler does not
 * perform. Probes are therefore derived from the matrix, not hand-listed: a row
 * claiming record scope with no registered probe fails the suite, so the claim
 * cannot be made without being proved.
 */

const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const {
  SURFACE, REQUIRES_SESSION, FORBIDDEN_FOR_MARKETING, FORBIDDEN_FOR_MANAGER,
  RECORD_SCOPED, PROTECTION_ENFORCING,
} = require('../../src/shared/contracts/ipc-surface');
const { SCHEMAS } = require('../../src/shared/validation/schemas');
const { registerAll } = require('../../src/main/ipc/registry');
const handlerFactory = require('../../src/main/ipc/handlers');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const { today, addDays } = require('../../src/shared/contracts/dates');

/* Payloads valid enough to reach the AUTHORIZATION check. A call refused for a
   malformed body proves nothing about permissions. */
const PROBE = (ctx) => ({
  'auth:setup': { username: 'probe', password: 'a-long-enough-probe-pw', passwordConfirm: 'a-long-enough-probe-pw' },
  'auth:login': { username: 'probe', password: 'a-long-enough-probe-pw' },
  'auth:changePassword': { currentPassword: 'x', newPassword: 'another-long-probe-pw', newPasswordConfirm: 'another-long-probe-pw' },
  'customers:list': {},
  'customers:get': { id: ctx.foreignCustomer },
  'customers:history': { id: ctx.foreignCustomer },
  'customers:summary': { id: ctx.foreignCustomer },
  'customers:picker': {},
  'customers:create': { code: 'PROBE-1', fullName: 'PROBE GUEST' },
  'customers:update': { id: ctx.foreignCustomer, phone: '1' },
  'customers:assign': { id: ctx.foreignCustomer, profileId: ctx.senaProfile },
  'customers:delete': { id: ctx.foreignCustomer },
  'customers:protection': { id: ctx.foreignCustomer },
  'reservations:list': {},
  'reservations:listDeleted': {},
  'reservations:get': { id: ctx.foreignReservation },
  'reservations:create': { customerId: ctx.foreignCustomer, checkIn: addDays(today(), 200), checkOut: addDays(today(), 202) },
  'reservations:update': { id: ctx.foreignReservation, checkIn: addDays(today(), 210), checkOut: addDays(today(), 212) },
  'reservations:cancel': { id: ctx.foreignReservation, reason: 'probe' },
  'reservations:delete': { id: ctx.foreignReservation, reason: 'probe' },
  'crmNotes:list': { customerId: ctx.foreignCustomer },
  'crmNotes:create': { customerId: ctx.foreignCustomer, note: 'probe' },
  'crmNotes:update': { id: ctx.foreignNote, note: 'probe' },
  'crmNotes:delete': { id: ctx.foreignNote },
  'profiles:list': {},
  'profiles:get': { id: ctx.keremProfile },
  'profiles:related': { id: ctx.keremProfile },
  'profiles:create': { fullName: 'PROBE PROFILE' },
  'profiles:update': { id: ctx.keremProfile, inactive: false },
  'profiles:delete': { id: ctx.keremProfile },
  'users:list': {},
  'users:create': { username: 'probeuser', password: 'a-long-enough-probe-pw', role: 'MANAGER' },
  'users:update': { id: ctx.adminUser, fullName: 'probe' },
  'users:delete': { id: ctx.managerUser },
  'settings:all': {},
  'settings:set': { key: 'appearance.theme', value: 'dark' },
  'settings:permissions': {},
  'settings:setPermissions': { matrix: {} },
  'notifications:list': {},
  'notifications:unreadCount': {},
  'notifications:markRead': { id: ctx.foreignNotification },
  'notifications:markAllRead': {},
  'notifications:delete': { id: ctx.foreignNotification },
  'dashboard:load': {},
  'calendar:month': { year: 2027, month: 3 },
  'calendar:day': { date: addDays(today(), 5) },
  'audit:list': {},
  'export:run': { entity: 'customerlist', params: {} },
  'photos:read': { name: 'photo_x' },
  'photos:remove': { name: 'photo_x' },
  'backup:list': {},
  'backup:create': {},
  'backup:restore': { name: 'nope.mmhbackup' },
  'app:info': {},
  'app:needsSetup': {},
  'updates:check': {},
  'updates:install': {},
});

/* Channels not invoked during sweeps because doing so would end the session the
   probe runs under, or block on a native dialog. Keep this as short as it can
   be: every entry is a contract this suite stops enforcing. */
const DO_NOT_SWEEP = new Set(['auth:logout', 'auth:session', 'photos:import']);

/* Calls against ANOTHER marketer's record, derived from RECORD_SCOPED. */
const FOREIGN_PROBE = {
  'customers:get': (c) => ({ id: c.foreignCustomer }),
  'customers:history': (c) => ({ id: c.foreignCustomer }),
  'customers:update': (c) => ({ id: c.foreignCustomer, phone: 'HACKED' }),
  'customers:assign': (c) => ({ id: c.foreignCustomer, profileId: c.senaProfile }),
  'customers:delete': (c) => ({ id: c.foreignCustomer }),
  'customers:create': (c) => ({ code: 'PROBE-CROSS', fullName: 'CROSS OWNED', marketingProfileId: c.keremProfile }),
  'customers:protection': (c) => ({ id: c.foreignCustomer }),
  'reservations:get': (c) => ({ id: c.foreignReservation }),
  'reservations:update': (c) => ({ id: c.foreignReservation, checkIn: addDays(today(), 220), checkOut: addDays(today(), 222) }),
  'reservations:cancel': (c) => ({ id: c.foreignReservation, reason: 'probe' }),
  'reservations:delete': (c) => ({ id: c.foreignReservation, reason: 'probe' }),
  'crmNotes:list': (c) => ({ customerId: c.foreignCustomer }),
  'crmNotes:create': (c) => ({ customerId: c.foreignCustomer, note: 'probe' }),
  'crmNotes:update': (c) => ({ id: c.foreignNote, note: 'probe' }),
  'crmNotes:delete': (c) => ({ id: c.foreignNote }),
  'profiles:related': (c) => ({ id: c.keremProfile }),
  'notifications:markRead': (c) => ({ id: c.foreignNotification }),
  'notifications:delete': (c) => ({ id: c.foreignNotification }),
};

/* Calls that would MOVE a guest between marketers, derived from PROTECTION_ENFORCING. */
const PROTECTION_PROBE = {
  'customers:assign': (c) => ({ id: c.protectedCustomer, profileId: c.senaProfile }),
  'customers:update': (c) => ({ id: c.protectedCustomer, marketingProfileId: c.senaProfile }),
  'reservations:create': (c) => ({ customerId: c.protectedCustomer, checkIn: addDays(today(), 300), checkOut: addDays(today(), 302) }),
  'reservations:update': (c) => ({ id: c.ownReservation, customerId: c.protectedCustomer }),
};

/** A stand-in for Electron's ipcMain that keeps the registered handlers. */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, payload, event = { sender: 'trusted' }) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for ${channel}`);
      return fn(event, payload);
    },
    size: () => handlers.size,
  };
}

module.exports = async function () {
  const s = new Suite('ipc/surface-enforcement');
  const app = new TestApp('mmh-ipc');

  try {
    await app.bootstrapAdmin();
    const kerem = await app.createMarketingUser({ username: 'kerem', profileName: 'KEREM SARICICEK' });
    const sena = await app.createMarketingUser({ username: 'sena', profileName: 'SENA NUR AKMUT' });
    const manager = await app.createManagerUser();
    const adminUser = app.db.prepare("SELECT id FROM users WHERE role='ADMIN'").get().id;

    // A guest of KEREM that SENA must never reach, with a booking and a note.
    const foreign = customers.create(app.ctx(), {
      code: 'IPC-FOREIGN', fullName: 'IPC FOREIGN GUEST', phone: 'SECRET-PHONE',
      marketingProfileId: kerem.profileId,
    });
    const foreignRes = reservations.create(app.ctx(), {
      customerId: foreign.id, checkIn: addDays(today(), 30), checkOut: addDays(today(), 33),
      invitedByProfileId: kerem.profileId,
    });
    const foreignNote = require('../../src/main/services/support-services')
      .crmNotes.create(app.ctx(), { customerId: foreign.id, note: 'kerem only' });
    const protectedGuest = customers.create(app.ctx(), {
      code: 'IPC-PROTECTED', fullName: 'IPC PROTECTED GUEST', marketingProfileId: kerem.profileId,
    });
    const foreignNotification = app.db.prepare(`
      INSERT INTO notifications (type, title, message, target_profile_id, created_at)
      VALUES ('PROBE','kerem only','kerem only', ?, ?)`)
      .run(kerem.profileId, new Date().toISOString()).lastInsertRowid;
    // A reservation SENA owns, for the retarget probe.
    await app.login('sena', sena.password);
    const senaGuest = customers.create(app.ctx(), { code: 'IPC-SENA', fullName: 'IPC SENA GUEST' });
    const senaRes = reservations.create(app.ctx(), {
      customerId: senaGuest.id, checkIn: addDays(today(), 40), checkOut: addDays(today(), 42),
    });
    await app.loginAdmin();

    const probeCtx = {
      foreignCustomer: foreign.id, foreignReservation: foreignRes.id, foreignNote: foreignNote.id,
      protectedCustomer: protectedGuest.id, ownReservation: senaRes.id,
      keremProfile: kerem.profileId, senaProfile: sena.profileId,
      adminUser, managerUser: manager.userId, foreignNotification,
    };
    s.check('every probe fixture was created',
      Object.values(probeCtx).every((v) => Number.isInteger(v) && v > 0), JSON.stringify(probeCtx));

    // ------------------------------------------------------------- registry
    const ipc = fakeIpcMain();
    const stubs = {
      app: { info: () => ({ name: 'test', version: '0.0.0', schemaVersion: 1 }) },
      backup: {
        list: (ctx) => require('../../src/main/services/guard').requireCapability(ctx, 'backup.read') && [],
        create: (ctx) => { require('../../src/main/services/guard').requireCapability(ctx, 'backup.create'); return { name: 'x' }; },
        restore: (ctx) => { require('../../src/main/services/guard').requireCapability(ctx, 'backup.restore'); return { ok: true }; },
      },
      photos: {
        importPhoto: (ctx) => { require('../../src/main/services/guard').requireCapability(ctx, 'customers.update'); return null; },
        read: (ctx) => { require('../../src/main/services/guard').requireCapability(ctx, 'customers.read'); return null; },
        remove: (ctx) => { require('../../src/main/services/guard').requireCapability(ctx, 'customers.update'); return { ok: true }; },
      },
      updates: { check: () => ({ state: 'unavailable' }), install: (ctx) => { require('../../src/main/services/guard').requireCapability(ctx, 'backup.create'); return { ok: true }; } },
      exporter: require('../../src/main/services/export-service').build({
        dialog: { showSaveDialog: async () => ({ canceled: true }) }, getWindow: () => null,
      }),
    };
    const handlers = handlerFactory.build(stubs);

    let registrationError = null;
    try {
      registerAll({ ipcMain: ipc, handlers, getContext: () => app.ctx(), isTrustedSender: () => true, log: () => {} });
    } catch (err) { registrationError = err.message; }
    s.check('the registry accepts a complete, documented handler set',
      registrationError === null, String(registrationError));
    s.check('every documented channel is registered',
      ipc.size() === Object.keys(SURFACE).length, `${ipc.size()} of ${Object.keys(SURFACE).length}`);

    // A channel with no surface entry must break the build, not ship.
    const rogue = fakeIpcMain();
    let rogueError = null;
    try {
      registerAll({ ipcMain: rogue, handlers: { ...handlers, 'customers:peekAll': () => ({}) },
        getContext: () => app.ctx(), isTrustedSender: () => true, log: () => {} });
    } catch (err) { rogueError = err.message; }
    s.check('an undocumented channel refuses to register',
      rogueError && rogueError.includes('customers:peekAll'), String(rogueError));

    const orphan = fakeIpcMain();
    let orphanError = null;
    try {
      const missing = { ...handlers };
      delete missing['customers:get'];
      registerAll({ ipcMain: orphan, handlers: missing, getContext: () => app.ctx(), isTrustedSender: () => true, log: () => {} });
    } catch (err) { orphanError = err.message; }
    s.check('a documented channel with no handler refuses to register',
      orphanError && orphanError.includes('customers:get'), String(orphanError));

    // ------------------------------------------------------ sender validation
    const untrusted = fakeIpcMain();
    registerAll({ ipcMain: untrusted, handlers, getContext: () => app.ctx(), isTrustedSender: () => false, log: () => {} });
    const spoofed = await untrusted.invoke('customers:list', {});
    s.check('a call from an untrusted sender is refused',
      spoofed.ok === false && spoofed.error.code === 'FORBIDDEN', JSON.stringify(spoofed));

    // -------------------------------------------------- unauthenticated sweep
    app.sessions.end();
    const probes = PROBE(probeCtx);
    for (const channel of REQUIRES_SESSION) {
      if (DO_NOT_SWEEP.has(channel)) continue;
      const res = await ipc.invoke(channel, probes[channel] ?? {});
      s.check(`unauthenticated: ${channel} is refused`, res.ok === false,
        res.ok ? 'ALLOWED WITHOUT A SESSION' : '');
    }

    // ----------------------------------------------------- MARKETING sweep
    await app.login('sena', sena.password);
    for (const channel of FORBIDDEN_FOR_MARKETING) {
      if (DO_NOT_SWEEP.has(channel)) continue;
      const res = await ipc.invoke(channel, probes[channel] ?? {});
      s.check(`MARKETING denied: ${channel}`, res.ok === false, res.ok ? 'ALLOWED FOR MARKETING' : '');
    }

    // ------------------------------------------------------- MANAGER sweep
    await app.login('manager', manager.password);
    for (const channel of FORBIDDEN_FOR_MANAGER) {
      if (DO_NOT_SWEEP.has(channel)) continue;
      const res = await ipc.invoke(channel, probes[channel] ?? {});
      s.check(`MANAGER denied: ${channel}`, res.ok === false, res.ok ? 'ALLOWED FOR MANAGER' : '');
    }

    // ---------------------------------------- record scope, driven by matrix
    const missingScopeProbe = RECORD_SCOPED.filter((c) => !FOREIGN_PROBE[c] && !DO_NOT_SWEEP.has(c));
    s.check('every record-scoped channel has a foreign-record probe registered',
      missingScopeProbe.length === 0,
      missingScopeProbe.length ? `NO PROBE FOR: ${missingScopeProbe.join(', ')}` : '');

    await app.login('sena', sena.password);
    for (const channel of RECORD_SCOPED) {
      if (!FOREIGN_PROBE[channel] || DO_NOT_SWEEP.has(channel)) continue;
      const res = await ipc.invoke(channel, FOREIGN_PROBE[channel](probeCtx));
      s.check(`record scope enforced: ${channel} against another marketer's record`,
        res.ok === false, res.ok ? 'REACHED A FOREIGN RECORD' : '');
    }

    // ------------------------------------ guest protection, driven by matrix
    const missingProtProbe = PROTECTION_ENFORCING.filter((c) => !PROTECTION_PROBE[c]);
    s.check('every protection-enforcing channel has a takeover probe registered',
      missingProtProbe.length === 0,
      missingProtProbe.length ? `NO PROBE FOR: ${missingProtProbe.join(', ')}` : '');

    for (const channel of PROTECTION_ENFORCING) {
      if (!PROTECTION_PROBE[channel]) continue;
      const res = await ipc.invoke(channel, PROTECTION_PROBE[channel](probeCtx));
      s.check(`guest protection enforced: ${channel}`, res.ok === false,
        res.ok ? 'TOOK OVER A PROTECTED GUEST' : '');
    }

    await app.loginAdmin();
    const stillKerem = customers.get(app.ctx(), { id: probeCtx.protectedCustomer });
    s.check('no protection probe moved the guest',
      stillKerem.marketing_name === 'KEREM SARICICEK', String(stillKerem.marketing_name));

    // --------------------------------------------- payload validation is real
    await app.login('sena', sena.password);
    const unknownField = await ipc.invoke('customers:update', { id: probeCtx.foreignCustomer, isAdmin: true });
    s.check('an unexpected field is rejected rather than carried into the update',
      unknownField.ok === false && unknownField.error.code === 'VALIDATION', JSON.stringify(unknownField));

    const badType = await ipc.invoke('customers:get', { id: 'not-a-number' });
    s.check('a wrong-typed id is rejected', badType.ok === false, JSON.stringify(badType));

    const hugePage = await ipc.invoke('customers:list', { pageSize: 10 ** 9 });
    s.check('an absurd page size is rejected', hugePage.ok === false, JSON.stringify(hugePage));

    const sqlInSort = await ipc.invoke('customers:list', { sort: "name; DROP TABLE customers--" });
    s.check('a SQL fragment in a sort field cannot reach the query',
      sqlInSort.ok === true, JSON.stringify(sqlInSort.error));
    s.check('and the table it named is still there',
      app.db.prepare('SELECT COUNT(*) n FROM customers').get().n > 0);

    // ------------------------------------------------------- error hygiene
    const denied = await ipc.invoke('customers:get', { id: probeCtx.foreignCustomer });
    const wire = JSON.stringify(denied);
    s.check('a refusal carries no stack trace', !wire.includes('at '), wire.slice(0, 160));
    s.check('a refusal carries no SQL', !/SELECT|INSERT|UPDATE/i.test(wire), wire.slice(0, 160));
    s.check('a refusal carries no filesystem path', !/\/(home|tmp|Users)\//.test(wire), wire.slice(0, 160));

    // ------------------------------------------------------ schema coverage
    const undocumented = Object.keys(SCHEMAS).filter((c) => !SURFACE[c]);
    s.check('every schema corresponds to a documented channel', undocumented.length === 0, undocumented.join(', '));
    s.check('the surface is non-trivial', Object.keys(SURFACE).length >= 50, String(Object.keys(SURFACE).length));
  } finally {
    app.close();
  }

  return s.finish();
};
