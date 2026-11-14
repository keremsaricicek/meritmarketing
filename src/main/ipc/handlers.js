'use strict';
/* Channel → service. Thin by design.
 *
 * No authorization logic lives here. Every check happens inside the service, so
 * a service called from a future HTTP API or a CLI is exactly as protected as
 * one called from this bridge. A handler that "helpfully" checked a role here
 * would create a second, divergent copy of the rule.
 */

const customers = require('../services/customer-service');
const reservations = require('../services/reservation-service');
const authService = require('../services/auth-service');
const support = require('../services/support-services');
const oversight = require('../services/oversight-service');
const bulk = require('../services/bulk-service');
const guests = require('../services/guest-service');
const guard = require('../services/guard');
const { CONFIGURABLE } = require('../../shared/contracts/roles');
const { validation } = require('../../shared/errors');

function build({ app, backup, photos, updates, exporter, importer, reporter }) {
  return {
    'app:info': (ctx) => app.info(ctx),
    'app:needsSetup': (ctx) => authService.needsSetup(ctx.db),
    /* No argument, so there is no path to sanitise: the folder is the
       application's own, resolved in the main process. shell.openPath hands a
       directory to the OS file manager — it is not a shell command and cannot
       execute anything. */
    'app:openDataFolder': async (ctx) => {
      guard.requireCapability(ctx, 'backup.read');
      const { shell } = require('electron');
      const target = ctx.paths.root;
      const problem = await shell.openPath(target);
      if (problem) throw validation('The data folder could not be opened.');
      ctx.audit({ action: 'DATA_FOLDER_OPEN', entity_type: 'app', description: 'Opened the application data folder' });
      return { ok: true };
    },

    'auth:setup': (ctx, p) => authService.setup(ctx.db, p, ctx),
    'auth:login': async (ctx, p) => {
      await authService.login(ctx.db, p, ctx);
      /* The renderer gets the sanitized view, never the row. */
      return ctx.sessions.toWire(Object.keys(CONFIGURABLE));
    },
    'auth:logout': (ctx) => authService.logout(ctx),
    'auth:session': (ctx) => ctx.sessions.toWire(Object.keys(CONFIGURABLE)),
    'auth:changePassword': (ctx, p) => authService.changePassword(ctx.db, p, ctx),

    'customers:list': (ctx, p) => customers.list(ctx, p),
    'customers:get': (ctx, p) => customers.get(ctx, p),
    'customers:history': (ctx, p) => customers.history(ctx, p),
    'customers:summary': (ctx, p) => customers.summary(ctx, p),
    'customers:picker': (ctx, p) => customers.picker(ctx, p),
    'customers:create': (ctx, p) => customers.create(ctx, p),
    'customers:update': (ctx, p) => customers.update(ctx, p),
    'customers:assign': (ctx, p) => customers.assign(ctx, p),
    'customers:delete': (ctx, p) => customers.remove(ctx, p),
    'customers:protection': (ctx, p) => customers.protectionState(ctx, p),
    'customers:bulkAssign': (ctx, p) => bulk.assign(ctx, p),

    'import:choose': (ctx) => importer.choose(ctx),
    'import:sheet': (ctx, p) => importer.sheet(ctx, p),
    'import:preview': (ctx, p) => importer.preview(ctx, p),
    'import:commit': (ctx, p) => importer.commit(ctx, p),
    'import:templates': (ctx) => importer.templates(ctx),
    'import:saveTemplate': (ctx, p) => importer.saveTemplate(ctx, p),
    'import:deleteTemplate': (ctx, p) => importer.deleteTemplate(ctx, p),
    'customers:duplicates': (ctx, p) => guests.duplicates(ctx, p),
    'customers:merge': (ctx, p) => guests.merge(ctx, p),
    'customers:setTags': (ctx, p) => guests.tags.setForCustomer(ctx, p),
    'customers:setDates': (ctx, p) => guests.specialDates.set(ctx, p),
    'customers:recent': (ctx) => guests.recent.list(ctx),
    'customers:viewed': (ctx, p) => guests.recent.viewed(ctx, p),

    'tags:list': (ctx) => guests.tags.list(ctx),
    'tags:create': (ctx, p) => guests.tags.create(ctx, p),
    'tags:update': (ctx, p) => guests.tags.update(ctx, p),
    'tags:delete': (ctx, p) => guests.tags.remove(ctx, p),

    'reminders:due': (ctx) => guests.reminders.due(ctx),
    'reminders:forCustomer': (ctx, p) => guests.reminders.forCustomer(ctx, p),
    'reminders:done': (ctx, p) => guests.reminders.markDone(ctx, p),

    'views:list': (ctx, p) => guests.views.list(ctx, p),
    'views:save': (ctx, p) => guests.views.save(ctx, p),
    'views:delete': (ctx, p) => guests.views.remove(ctx, p),

    'reservations:list': (ctx, p) => reservations.list(ctx, p),
    'reservations:listDeleted': (ctx, p) => reservations.listDeleted(ctx, p),
    'reservations:get': (ctx, p) => reservations.get(ctx, p),
    'reservations:create': (ctx, p) => reservations.create(ctx, p),
    'reservations:update': (ctx, p) => reservations.update(ctx, p),
    'reservations:cancel': (ctx, p) => reservations.cancel(ctx, p),
    'reservations:delete': (ctx, p) => reservations.remove(ctx, p),

    'crmNotes:list': (ctx, p) => support.crmNotes.list(ctx, p),
    'crmNotes:create': (ctx, p) => support.crmNotes.create(ctx, p),
    'crmNotes:update': (ctx, p) => support.crmNotes.update(ctx, p),
    'crmNotes:delete': (ctx, p) => support.crmNotes.remove(ctx, p),
    'crmNotes:bulkCreate': (ctx, p) => bulk.note(ctx, p),

    'profiles:list': (ctx, p) => support.profiles.list(ctx, p),
    'profiles:get': (ctx, p) => support.profiles.get(ctx, p),
    'profiles:related': (ctx, p) => support.profiles.relatedCustomers(ctx, p),
    'profiles:create': (ctx, p) => support.profiles.create(ctx, p),
    'profiles:update': (ctx, p) => support.profiles.update(ctx, p),
    'profiles:delete': (ctx, p) => support.profiles.remove(ctx, p),

    'users:list': (ctx) => support.users.list(ctx),
    'users:create': (ctx, p) => support.users.create(ctx, p),
    'users:update': (ctx, p) => support.users.update(ctx, p),
    'users:delete': (ctx, p) => support.users.remove(ctx, p),

    'settings:all': (ctx) => support.settings.all(ctx),
    'settings:set': (ctx, p) => support.settings.set(ctx, p),
    'settings:permissions': (ctx) => support.settings.permissions(ctx),
    'settings:setPermissions': (ctx, p) => support.settings.setPermissions(ctx, p),

    'notifications:list': (ctx) => support.notifications.list(ctx),
    'notifications:unreadCount': (ctx) => support.notifications.unreadCount(ctx),
    'notifications:markRead': (ctx, p) => support.notifications.markRead(ctx, p),
    'notifications:markAllRead': (ctx) => support.notifications.markAllRead(ctx),
    'notifications:delete': (ctx, p) => support.notifications.remove(ctx, p),

    'dashboard:load': (ctx, p) => support.dashboard.load(ctx, p),
    'calendar:month': (ctx, p) => support.calendar.month(ctx, p),
    'calendar:day': (ctx, p) => support.calendar.day(ctx, p),

    'audit:list': (ctx, p) => support.audit.list(ctx, p),

    'activity:feed': (ctx, p) => oversight.activity.feed(ctx, p),
    'search:global': (ctx, p) => oversight.search.global(ctx, p),
    'team:overview': (ctx) => oversight.team.overview(ctx),

    'export:run': (ctx, p) => exporter.run(ctx, p),
    'export:columns': (ctx, p) => exporter.columns(ctx, p),

    'reports:monthlyPdf': (ctx, p) => reporter.monthlyPdf(ctx, p),

    'photos:import': (ctx) => photos.importPhoto(ctx),
    'photos:crop': (ctx, p) => photos.crop(ctx, p),
    'photos:read': (ctx, p) => photos.read(ctx, p),
    'photos:remove': (ctx, p) => photos.remove(ctx, p),

    'backup:list': (ctx) => backup.list(ctx),
    'backup:create': (ctx, p) => backup.create(ctx, p),
    'backup:restore': (ctx, p) => backup.restore(ctx, p),

    'updates:check': (ctx) => updates.check(ctx),
    'updates:install': (ctx) => updates.install(ctx),
  };
}

module.exports = { build };
