'use strict';
/* ADVERSARIAL PASS.
 *
 * Not a review of the code — an attempt to break it. Every probe here calls the
 * service or the IPC boundary directly with a payload the UI would never send,
 * as a session that should not be allowed to send it.
 *
 * The rule this file exists to enforce: "the UI never lets you do that" is not
 * a finding of safety unless the direct call also fails.
 */

const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const support = require('../../src/main/services/support-services');
const exportService = require('../../src/main/services/export-service');
const photoService = require('../../src/main/services/photo-service');
const { safeJoin } = require('../../src/main/paths');
const { today, addDays } = require('../../src/shared/contracts/dates');

const attempt = async (fn) => {
  try { return { ok: true, data: await fn() }; }
  catch (err) { return { ok: false, code: err.code, message: err.message }; }
};

module.exports = async function () {
  const s = new Suite('ipc/attack-matrix');
  const app = new TestApp('mmh-attack');

  try {
    await app.bootstrapAdmin();
    const kerem = await app.createMarketingUser({ username: 'kerem', profileName: 'KEREM SARICICEK' });
    const sena = await app.createMarketingUser({ username: 'sena', profileName: 'SENA NUR AKMUT' });
    const manager = await app.createManagerUser();

    const victim = customers.create(app.ctx(), {
      code: 'ATK-VICTIM', fullName: 'ATTACK VICTIM GUEST',
      phone: 'VICTIM-PHONE', passportNo: 'VICTIM-PASSPORT',
      marketingProfileId: kerem.profileId,
    });
    const victimRes = reservations.create(app.ctx(), {
      customerId: victim.id, checkIn: addDays(today(), 25), checkOut: addDays(today(), 28),
      invitedByProfileId: kerem.profileId,
    });
    support.crmNotes.create(app.ctx(), { customerId: victim.id, note: 'VICTIM SECRET NOTE' });

    // ================================================ horizontal escalation
    await app.login('sena', sena.password);
    const sctx = app.ctx();

    const horizontal = {
      'customers.get':       await attempt(() => customers.get(sctx, { id: victim.id })),
      'customers.update':    await attempt(() => customers.update(sctx, { id: victim.id, fullName: 'HACKED' })),
      'customers.delete':    await attempt(() => customers.remove(sctx, { id: victim.id })),
      'customers.assign':    await attempt(() => customers.assign(sctx, { id: victim.id, profileId: sena.profileId })),
      'customers.history':   await attempt(() => customers.history(sctx, { id: victim.id })),
      'crmNotes.list':       await attempt(() => support.crmNotes.list(sctx, { customerId: victim.id })),
      'crmNotes.create':     await attempt(() => support.crmNotes.create(sctx, { customerId: victim.id, note: 'x' })),
      'reservations.get':    await attempt(() => reservations.get(sctx, { id: victimRes.id })),
      'reservations.update': await attempt(() => reservations.update(sctx, { id: victimRes.id, checkIn: addDays(today(), 26), checkOut: addDays(today(), 29) })),
      'reservations.cancel': await attempt(() => reservations.cancel(sctx, { id: victimRes.id, reason: 'x' })),
      'profiles.related':    await attempt(() => support.profiles.relatedCustomers(sctx, { id: kerem.profileId })),
    };
    for (const [verb, res] of Object.entries(horizontal)) {
      s.check(`horizontal escalation blocked: ${verb}`, res.ok === false, JSON.stringify(res).slice(0, 140));
    }

    // ================================================== vertical escalation
    const vertical = {
      'users.list':               await attempt(() => support.users.list(sctx)),
      'users.create':             await attempt(() => support.users.create(sctx, { username: 'evil', password: 'evil-long-password', role: 'ADMIN' })),
      'users.update':             await attempt(() => support.users.update(sctx, { id: sena.userId, role: 'ADMIN' })),
      'users.delete':             await attempt(() => support.users.remove(sctx, { id: manager.userId })),
      'profiles.create':          await attempt(() => support.profiles.create(sctx, { fullName: 'EVIL PROFILE' })),
      'profiles.update':          await attempt(() => support.profiles.update(sctx, { id: kerem.profileId, inactive: true })),
      'profiles.delete':          await attempt(() => support.profiles.remove(sctx, { id: kerem.profileId })),
      'audit.list':               await attempt(() => support.audit.list(sctx, {})),
      'settings.setPermissions':  await attempt(() => support.settings.setPermissions(sctx, { matrix: { MARKETING: { 'customers.delete': true } } })),
      'reservations.delete':      await attempt(() => reservations.remove(sctx, { id: victimRes.id, reason: 'x' })),
      'reservations.listDeleted': await attempt(() => reservations.listDeleted(sctx, {})),
    };
    for (const [verb, res] of Object.entries(vertical)) {
      s.check(`vertical escalation blocked: ${verb}`, res.ok === false, JSON.stringify(res).slice(0, 140));
    }

    // ============================================= IDOR by id enumeration
    const walked = await attempt(async () => {
      const found = [];
      for (let id = 1; id <= 60; id++) {
        const r = await attempt(() => customers.get(sctx, { id }));
        if (r.ok && r.data && r.data.marketing_name && r.data.marketing_name !== 'SENA NUR AKMUT') {
          found.push(`${id}:${r.data.full_name}`);
        }
      }
      return found;
    });
    s.check('IDOR: customer ids cannot be walked into another marketer\'s book',
      walked.data.length === 0, JSON.stringify(walked.data));

    const walkedRes = await attempt(async () => {
      const found = [];
      for (let id = 1; id <= 60; id++) {
        const r = await attempt(() => reservations.get(sctx, { id }));
        if (r.ok && r.data && r.data.invited_by_name && r.data.invited_by_name !== 'SENA NUR AKMUT') {
          found.push(`${id}:${r.data.invited_by_name}`);
        }
      }
      return found;
    });
    s.check('IDOR: reservation ids cannot be walked into another marketer\'s book',
      walkedRes.data.length === 0, JSON.stringify(walkedRes.data));

    // ==================================================== crafted payloads
    // Ownership must move only through assign — never as a field on an edit.
    const ownershipViaUpdate = await attempt(() => customers.update(sctx, {
      id: victim.id, marketingProfileId: sena.profileId }));
    s.check('crafted ownership change through customers.update is refused',
      ownershipViaUpdate.ok === false, JSON.stringify(ownershipViaUpdate));

    // A marketer creating a guest owned by somebody else writes into their book.
    const crossWrite = await attempt(() => customers.create(sctx, {
      code: 'ATK-CROSS', fullName: 'CROSS OWNED', marketingProfileId: kerem.profileId }));
    s.check('a marketer cannot create a guest owned by another marketer',
      crossWrite.ok === false, JSON.stringify(crossWrite));

    // Invited By must be forced to self regardless of what is sent.
    const ownGuest = customers.create(sctx, { code: 'ATK-OWN', fullName: 'SENA OWN GUEST' });
    const forgedInvite = reservations.create(sctx, {
      customerId: ownGuest.id, checkIn: addDays(today(), 50), checkOut: addDays(today(), 52),
      invitedByProfileId: kerem.profileId,
    });
    const forged = reservations.get(sctx, { id: forgedInvite.id });
    s.check('a crafted invitedByProfileId is overridden with the caller\'s own profile',
      forged.invited_by_name === 'SENA NUR AKMUT', String(forged.invited_by_name));

    // Retargeting a reservation is a create in disguise and needs the same checks.
    const retarget = await attempt(() => reservations.update(sctx, {
      id: forgedInvite.id, customerId: victim.id }));
    s.check('retargeting a reservation onto another marketer\'s guest is refused',
      retarget.ok === false, JSON.stringify(retarget));

    // Nonexistent target must be rejected, not silently orphan the row.
    const orphan = await attempt(() => reservations.update(sctx, {
      id: forgedInvite.id, customerId: 999999 }));
    s.check('retargeting onto a nonexistent guest is refused',
      orphan.ok === false && orphan.code === 'VALIDATION', JSON.stringify(orphan));

    // ============================================ guest protection bypasses
    const protectedGuest = victim.id;
    const protectionPaths = {
      'reservations.create': await attempt(() => reservations.create(sctx, {
        customerId: protectedGuest, checkIn: addDays(today(), 60), checkOut: addDays(today(), 62) })),
      'customers.assign':    await attempt(() => customers.assign(sctx, { id: protectedGuest, profileId: sena.profileId })),
      'customers.update':    await attempt(() => customers.update(sctx, { id: protectedGuest, marketingProfileId: sena.profileId })),
    };
    for (const [verb, res] of Object.entries(protectionPaths)) {
      s.check(`guest protection enforced on ${verb}`, res.ok === false, JSON.stringify(res).slice(0, 140));
    }
    s.check('the protection refusal names no owner and no expiry date',
      protectionPaths['reservations.create'].message === 'Guest protection period has not expired.',
      String(protectionPaths['reservations.create'].message));

    await app.loginAdmin();
    const untouched = customers.get(app.ctx(), { id: victim.id });
    s.check('no attack moved the guest', untouched.marketing_name === 'KEREM SARICICEK', String(untouched.marketing_name));

    // ============================================ MANAGER-specific boundary
    await app.login('manager', manager.password);
    const mctx = app.ctx();
    const managerLimits = {
      'users.list':              await attempt(() => support.users.list(mctx)),
      'users.create':            await attempt(() => support.users.create(mctx, { username: 'mgrmade', password: 'a-long-password-x', role: 'ADMIN' })),
      'settings.setPermissions': await attempt(() => support.settings.setPermissions(mctx, { matrix: {} })),
      'reservations.delete':     await attempt(() => reservations.remove(mctx, { id: victimRes.id, reason: 'x' })),
    };
    for (const [verb, res] of Object.entries(managerLimits)) {
      s.check(`MANAGER boundary holds: ${verb}`, res.ok === false, JSON.stringify(res).slice(0, 140));
    }
    // …but a MANAGER must still be able to do their job.
    s.check('MANAGER can still read every guest',
      customers.list(mctx, { pageSize: 500 }).total > 1);
    s.check('MANAGER can still reassign ownership',
      (await attempt(() => customers.assign(mctx, { id: victim.id, profileId: sena.profileId }))).ok === true);
    // put it back
    customers.assign(mctx, { id: victim.id, profileId: kerem.profileId });

    // ============================== the permission matrix cannot escalate
    await app.loginAdmin();
    support.settings.setPermissions(app.ctx(), {
      matrix: { MARKETING: {
        'customers.delete': true,      // configurable — should take effect
        'reservations.delete': true,   // ADMIN-only — must be ignored
        'backup.create': true,         // ADMIN-only — must be ignored
        'users.create': true,          // not configurable at all — must be ignored
      } },
    });
    const stored = support.settings.permissions(app.ctx());
    s.check('a configurable capability can be granted',
      stored.matrix.MARKETING['customers.delete'] === true, JSON.stringify(stored.matrix.MARKETING));
    s.check('an ADMIN-only capability is not grantable through the matrix',
      stored.matrix.MARKETING['reservations.delete'] !== true, JSON.stringify(stored.matrix.MARKETING));
    s.check('a non-configurable capability never appears in the matrix at all',
      !('users.create' in stored.matrix.MARKETING), JSON.stringify(Object.keys(stored.matrix.MARKETING)));

    await app.login('sena', sena.password);
    const afterGrant = app.ctx();
    s.check('the granted capability really works',
      afterGrant.sessions.can('customers.delete') === true);
    s.check('the ignored ADMIN-only grant did NOT take effect',
      afterGrant.sessions.can('reservations.delete') === false);
    const stillBlocked = await attempt(() => reservations.remove(afterGrant, { id: victimRes.id, reason: 'x' }));
    s.check('and the ADMIN-only verb is still refused after the attempted grant',
      stillBlocked.ok === false, JSON.stringify(stillBlocked));

    // ============================================== export scope + injection
    await app.loginAdmin();
    // A guest whose name is a spreadsheet formula.
    customers.create(app.ctx(), { code: 'ATK-CSV', fullName: '=cmd|\'/c calc\'!A1' });
    customers.create(app.ctx(), { code: 'ATK-CSV2', fullName: '+SUM(1,2)' });
    customers.create(app.ctx(), { code: 'ATK-CSV3', fullName: '@import' });
    const exporter = exportService.build({ dialog: null, getWindow: () => null });
    const csv = exporter.render(app.ctx(), { entity: 'customerlist', params: {} });
    s.check('a formula-shaped name is neutralised in CSV',
      !/,"=cmd/.test(csv.csv) && csv.csv.includes("\"'=cmd"), csv.csv.split('\n').find((l) => l.includes('cmd')) || '');
    s.check('a + prefixed name is neutralised', csv.csv.includes("\"'+SUM"), 'plus-prefixed name not escaped');
    s.check('an @ prefixed name is neutralised', csv.csv.includes("\"'@import"), 'at-prefixed name not escaped');

    await app.login('sena', sena.password);
    const scopedCsv = exporter.render(app.ctx(), { entity: 'customerlist', params: {} });
    s.check('an export cannot see another marketer\'s guest',
      !scopedCsv.csv.includes('ATTACK VICTIM GUEST'), scopedCsv.csv.slice(0, 200));
    const craftedCsv = exporter.render(app.ctx(), { entity: 'customerlist', params: { assignedTo: kerem.profileId } });
    s.check('a crafted assignedTo cannot widen an export',
      !craftedCsv.csv.includes('ATTACK VICTIM GUEST'), craftedCsv.csv.slice(0, 200));
    const deletedExport = await attempt(() => exporter.render(app.ctx(), { entity: 'deleted', params: {} }));
    s.check('MARKETING cannot export deleted history', deletedExport.ok === false, JSON.stringify(deletedExport));
    const auditExport = await attempt(() => exporter.render(app.ctx(), { entity: 'audit', params: {} }));
    s.check('MARKETING cannot export the audit log', auditExport.ok === false, JSON.stringify(auditExport));

    // ==================================================== path traversal
    const traversals = ['../../../etc/passwd', '..\\..\\windows\\system32', '/etc/passwd',
      'a/../../b', 'photo/../../../secret', './../data/merit-marketing.sqlite3'];
    for (const attemptPath of traversals) {
      s.check(`path traversal refused: ${attemptPath}`,
        safeJoin(app.paths.photos, attemptPath) === null, String(safeJoin(app.paths.photos, attemptPath)));
    }
    s.check('a legitimate managed name still resolves',
      typeof safeJoin(app.paths.photos, 'photo_123_abc.png') === 'string');

    // ============================================ photo content sniffing
    s.check('a PE executable is not accepted as an image',
      photoService.detect(Buffer.from('MZ\x90\x00\x03', 'binary')) === null);
    s.check('an HTML file is not accepted as an image',
      photoService.detect(Buffer.from('<html><script>alert(1)</script>')) === null);
    s.check('a real PNG signature is accepted',
      photoService.detect(Buffer.from('89504e470d0a1a0a0000000d', 'hex')) !== null);

    // ==================================================== SQL injection
    await app.loginAdmin();
    const injections = [
      "'; DROP TABLE customers; --",
      "1 OR 1=1",
      "' UNION SELECT password_hash FROM users --",
      "%' OR '1'='1",
    ];
    for (const payload of injections) {
      const res = await attempt(() => customers.list(app.ctx(), { search: payload, pageSize: 50 }));
      s.check(`SQL injection in search is inert: ${payload.slice(0, 24)}`,
        res.ok === true, JSON.stringify(res).slice(0, 120));
    }
    s.check('the customers table survived every injection attempt',
      app.db.prepare('SELECT COUNT(*) n FROM customers').get().n > 0);
    s.check('no password hash leaked through a union attempt',
      !JSON.stringify(customers.list(app.ctx(), { search: injections[2], pageSize: 50 })).includes('$argon2'));

    // A sort field is a whitelist lookup, never interpolated.
    const sortInjection = await attempt(() => customers.list(app.ctx(),
      { sort: 'name; DELETE FROM customers', pageSize: 5 }));
    s.check('a SQL fragment in a sort field cannot reach the query',
      sortInjection.ok === true && app.db.prepare('SELECT COUNT(*) n FROM customers').get().n > 0);

    // ============================================== audit cannot be edited
    s.check('there is no audit update verb', typeof support.audit.update === 'undefined');
    s.check('there is no audit delete verb', typeof support.audit.remove === 'undefined'
      && typeof support.audit.delete === 'undefined');

    // ============================================= fail-closed on no session
    app.sessions.end();
    const noSession = app.ctx();
    const anonymous = {
      'customers.list':   await attempt(() => customers.list(noSession, {})),
      'reservations.list': await attempt(() => reservations.list(noSession, {})),
      'dashboard.load':   await attempt(() => support.dashboard.load(noSession, {})),
      'settings.all':     await attempt(() => support.settings.all(noSession)),
      'notifications.unreadCount': await attempt(() => support.notifications.unreadCount(noSession)),
      'audit.list':       await attempt(() => support.audit.list(noSession, {})),
    };
    for (const [verb, res] of Object.entries(anonymous)) {
      s.check(`unauthenticated ${verb} fails closed`, res.ok === false, JSON.stringify(res).slice(0, 120));
    }

    // A MARKETING session with no profile must match NOTHING, not everything.
    const domain = require('../../src/main/services/domain');
    s.check('a MARKETING session without a profile scopes to nothing',
      domain.scopeProfileId({ role: 'MARKETING', profile_id: null }) === -1);
    s.check('a MARKETING session with profile_id 0 does not read as unrestricted',
      domain.scopeProfileId({ role: 'MARKETING', profile_id: 0 }) === 0);
  } finally {
    app.close();
  }

  return s.finish();
};
