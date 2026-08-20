'use strict';
/* The contextBridge.
 *
 * Every entry below is a named function bound to one channel. There is
 * deliberately no generic `invoke(channel, payload)`: that would hand the
 * renderer the whole IPC surface behind a single door, and an XSS in a guest's
 * name could then call any channel it could name. With this shape, a
 * compromised renderer can only call operations that already exist, and each of
 * those re-checks authorization in the main process anyway.
 *
 * Nothing from Node or Electron is exposed — no ipcRenderer, no fs, no path,
 * no shell, no process, no database handle.
 */

const { contextBridge, ipcRenderer } = require('electron');

/* Bind one channel to one function. The payload is passed through untouched:
   validation belongs in the main process, because a check performed here is a
   check the renderer could skip. */
const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload ?? {});

const api = {
  app: {
    info: call('app:info'),
    needsSetup: call('app:needsSetup'),
  },
  auth: {
    setup: call('auth:setup'),
    login: call('auth:login'),
    logout: call('auth:logout'),
    session: call('auth:session'),
    changePassword: call('auth:changePassword'),
  },
  customers: {
    list: call('customers:list'),
    get: call('customers:get'),
    history: call('customers:history'),
    summary: call('customers:summary'),
    picker: call('customers:picker'),
    create: call('customers:create'),
    update: call('customers:update'),
    assign: call('customers:assign'),
    delete: call('customers:delete'),
    protection: call('customers:protection'),
  },
  reservations: {
    list: call('reservations:list'),
    listDeleted: call('reservations:listDeleted'),
    get: call('reservations:get'),
    create: call('reservations:create'),
    update: call('reservations:update'),
    cancel: call('reservations:cancel'),
    delete: call('reservations:delete'),
  },
  crmNotes: {
    list: call('crmNotes:list'),
    create: call('crmNotes:create'),
    update: call('crmNotes:update'),
    delete: call('crmNotes:delete'),
  },
  profiles: {
    list: call('profiles:list'),
    get: call('profiles:get'),
    related: call('profiles:related'),
    create: call('profiles:create'),
    update: call('profiles:update'),
    delete: call('profiles:delete'),
  },
  users: {
    list: call('users:list'),
    create: call('users:create'),
    update: call('users:update'),
    delete: call('users:delete'),
  },
  settings: {
    all: call('settings:all'),
    set: call('settings:set'),
    permissions: call('settings:permissions'),
    setPermissions: call('settings:setPermissions'),
  },
  notifications: {
    list: call('notifications:list'),
    unreadCount: call('notifications:unreadCount'),
    markRead: call('notifications:markRead'),
    markAllRead: call('notifications:markAllRead'),
    delete: call('notifications:delete'),
  },
  dashboard: { load: call('dashboard:load') },
  calendar: { month: call('calendar:month'), day: call('calendar:day') },
  audit: { list: call('audit:list') },
  export: { run: call('export:run') },
  photos: {
    import: call('photos:import'),
    read: call('photos:read'),
    remove: call('photos:remove'),
  },
  backup: {
    list: call('backup:list'),
    create: call('backup:create'),
    restore: call('backup:restore'),
  },
  updates: {
    check: call('updates:check'),
    install: call('updates:install'),
    /* One-way notifications from main. The listener receives only the payload,
       never the IpcRendererEvent — handing that over would leak `sender` and
       with it a route back into the privileged side. */
    onStatus: (listener) => {
      if (typeof listener !== 'function') return () => {};
      const wrapped = (_event, status) => listener(status);
      ipcRenderer.on('updates:status', wrapped);
      return () => ipcRenderer.removeListener('updates:status', wrapped);
    },
  },
  session: {
    /* The main process ends a session when a user is disabled, their role
       changes, or the workstation goes idle. The renderer needs to hear about
       it so it can clear the screen rather than showing stale data. */
    onEnded: (listener) => {
      if (typeof listener !== 'function') return () => {};
      const wrapped = (_event, reason) => listener(reason);
      ipcRenderer.on('session:ended', wrapped);
      return () => ipcRenderer.removeListener('session:ended', wrapped);
    },
  },
};

/* Exposed as `ipc`, not `api`.
 *
 * `exposeInMainWorld` defines a NON-WRITABLE property, so the renderer's
 * adapter layer could not assign `window.api` on top of it — in strict mode
 * that assignment throws, the adapter script died on its first statement, and
 * every verb it was there to adapt silently did not exist. Handing the raw
 * bridge a name of its own removes the collision: `bridge.js` builds `api` out
 * of this, and the boundary here is unchanged either way, because the adapter
 * only renames verbs and adds no authority of its own. */
contextBridge.exposeInMainWorld('ipc', Object.freeze(api));
