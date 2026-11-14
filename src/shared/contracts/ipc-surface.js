'use strict';
/* THE AUTHORITATIVE IPC SECURITY SURFACE.
 *
 * Every privileged operation reachable from the renderer has an entry here. The
 * registry refuses to start if a handler exists without one, and the
 * enforcement tests refuse to pass if an entry claims a check the handler does
 * not perform.
 *
 * This is the same discipline the browser build's API matrix established,
 * moved to the boundary that will actually matter after packaging: today
 * window.api is an in-page object, but these are IPC channels, reachable by
 * anything running in the renderer.
 *
 * Fields
 *   auth         'required' | 'anonymous'  — is a session needed
 *   capability   the guard(...) string the handler must check, or null
 *   roles        which roles may successfully call it ('anon' = pre-auth)
 *   scope        'record' | 'query' | 'self' | 'none'
 *   protection   true when the verb can move guest ownership and must run the
 *                one-year rule for MARKETING callers
 *   validation   true when the handler validates the payload itself
 *   destructive  true when it changes data in a way a user would call "losing"
 *                something; these always audit
 *   audit        true when the operation must leave an audit row
 *   denial       the error code an unauthorized caller receives
 */

const SURFACE = {
  // ---------------------------------------------------------------- app
  'app:info':            { auth: 'anonymous', capability: null, roles: ['anon','ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, destructive: false, audit: false, denial: null,
                           notes: 'Version, channel and schema version for the About surface. No data.' },
  'app:needsSetup':      { auth: 'anonymous', capability: null, roles: ['anon','ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, destructive: false, audit: false, denial: null,
                           notes: 'Boolean "has a first administrator been created". Leaks nothing else.' },

  // --------------------------------------------------------------- auth
  'auth:setup':          { auth: 'anonymous', capability: null, roles: ['anon'], scope: 'none', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN',
                           notes: 'Refuses once any user exists, so it cannot mint a second administrator.' },
  'auth:login':          { auth: 'anonymous', capability: null, roles: ['anon'], scope: 'none', protection: false, validation: true, destructive: false, audit: true, denial: 'VALIDATION',
                           notes: 'Identical message for unknown user and wrong password.' },
  'auth:logout':         { auth: 'anonymous', capability: null, roles: ['anon','ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, destructive: false, audit: true, denial: null },
  'auth:session':        { auth: 'anonymous', capability: null, roles: ['anon','ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, destructive: false, audit: false, denial: null,
                           notes: 'Sanitized session only — never a password hash.' },
  'auth:changePassword': { auth: 'required', capability: null, roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, destructive: false, audit: true, denial: 'VALIDATION',
                           notes: 'Requires the current password; only ever changes the caller\'s own.' },

  // ---------------------------------------------------------- customers
  'customers:list':      { auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query',  protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Scope is applied to the SQL before any caller filter.' },
  'customers:get':       { auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'customers:history':   { auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Separate from the list so history never rides along on every row.' },
  'customers:summary':   { auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Identity-only for out-of-scope guests: no phone, passport, status or owner.' },
  'customers:picker':    { auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Deliberately unscoped so the finder cannot breed duplicates; withholds phone out of scope.' },
  'customers:create':    { auth: 'required', capability: 'customers.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN',
                           notes: 'MARKETING may only create guests owned by themselves.' },
  'customers:update':    { auth: 'required', capability: 'customers.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: true,  validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN',
                           notes: 'REJECTS a changed marketing_profile_id; ownership moves only through assign.' },
  'customers:assign':    { auth: 'required', capability: 'customers.assign', roles: ['ADMIN','MANAGER'],             scope: 'record', protection: true,  validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN',
                           notes: 'The authorized override. Writes explicit history; never rewrites historical Invited By.' },
  'customers:delete':    { auth: 'required', capability: 'customers.delete', roles: ['ADMIN','MANAGER'],             scope: 'record', protection: false, validation: true,  destructive: true,  audit: true,  denial: 'FORBIDDEN',
                           notes: 'Archive, not destroy — reservations and audit history survive.' },
  'customers:protection':{ auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'customers:bulkAssign':{ auth: 'required', capability: 'customers.assign', roles: ['ADMIN','MANAGER'],       scope: 'record', protection: true,  validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN',
                           notes: 'A loop over customers:assign, so scope and the one-year protection rule run per guest. A selection containing a guest outside the caller\'s scope is refused outright; business-rule refusals (protection, inactive profile, missing guest) are reported per row. One summary audit row plus the per-guest rows.' },

  // ------------------------------------------------------------- import
  'import:choose':       { auth: 'required', capability: 'customers.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Native Open dialog in the main process; .xlsx/.csv only, 10 MB cap, zip-bomb and macro checks, formulas never evaluated. The renderer receives a token, sheet names and sample rows — never a path.' },
  'import:sheet':        { auth: 'required', capability: 'customers.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Reads another sheet of the caller\'s own pending file; a token from another account resolves to nothing.' },
  'import:preview':      { auth: 'required', capability: 'customers.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Duplicates are matched across the whole book by phone, passport or Guest ID, using the customers:duplicates keys; a match outside the caller\'s scope is reported only as existing, never who.' },
  'import:commit':       { auth: 'required', capability: 'customers.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN',
                           notes: 'One transaction, one audit row with the counts. MARKETING imports are owned by the caller whatever the owner column says. "Update empty fields" needs customers.update, touches only in-scope guests and never ownership.' },
  'import:templates':    { auth: 'required', capability: 'customers.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'The caller\'s own saved column mappings (user_preferences).' },
  'import:saveTemplate': { auth: 'required', capability: 'customers.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'import:deleteTemplate':{ auth: 'required', capability: 'customers.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN' },
  // ------------------------------------------------- guest features
  'customers:duplicates':{ auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: true,  destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Same phone (digits only) or passport across the whole book; an out-of-scope match is reported only as "exists", never who.' },
  'customers:merge':     { auth: 'required', capability: 'customers.merge',  roles: ['ADMIN'],                       scope: 'record', protection: false, validation: true,  destructive: true,  audit: true,  denial: 'FORBIDDEN',
                           notes: 'Configurable, ADMIN-only by default. Moves notes, stays, reminders, tags and dates in one transaction; archives the duplicate with a pointer to the primary.' },
  'customers:setTags':   { auth: 'required', capability: 'customers.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN' },
  'customers:setDates':  { auth: 'required', capability: 'customers.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN',
                           notes: "Replaces the guest's special dates (label + month/day)." },
  'customers:recent':    { auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self',   protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: "The caller's last ten opened guests, re-checked against scope on every read." },
  'customers:viewed':    { auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: "Records a view in the caller's own preferences. Not audited: reading is not a change." },

  // --------------------------------------------------------------- tags
  'tags:list':           { auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Names and colours only, never which guests carry a tag.' },
  'tags:create':         { auth: 'required', capability: 'customers.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN',
                           notes: 'An existing name (any case) answers with the existing tag.' },
  'tags:update':         { auth: 'required', capability: 'settings.write',   roles: ['ADMIN','MANAGER'],             scope: 'none',   protection: false, validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN' },
  'tags:delete':         { auth: 'required', capability: 'settings.write',   roles: ['ADMIN','MANAGER'],             scope: 'none',   protection: false, validation: true,  destructive: true,  audit: true,  denial: 'FORBIDDEN' },

  // ---------------------------------------------------------- reminders
  'reminders:due':       { auth: 'required', capability: 'crm.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self',   protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: "The caller's own follow-ups due today or overdue, inside their scope." },
  'reminders:forCustomer': { auth: 'required', capability: 'crm.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'reminders:done':      { auth: 'required', capability: 'crm.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN' },

  // -------------------------------------------------------- saved views
  'views:list':          { auth: 'required', capability: 'customers.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: "The caller's own saved filters, newest first." },
  'views:save':          { auth: 'required', capability: 'customers.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN' },
  'views:delete':        { auth: 'required', capability: 'customers.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true,  destructive: true,  audit: true,  denial: 'FORBIDDEN' },

  // ------------------------------------------------------- reservations
  'reservations:list':   { auth: 'required', capability: 'reservations.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query',  protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Active and Cancelled are two disjoint views; neither includes deleted rows.' },
  'reservations:listDeleted': { auth: 'required', capability: 'reservations.deleted.read', roles: ['ADMIN','MANAGER'], scope: 'query', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'A separate VERB, not a view parameter — MARKETING cannot reach it by crafting a request.' },
  'reservations:get':    { auth: 'required', capability: 'reservations.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'A deleted row answers NOT_FOUND to anyone who may not see deleted history.' },
  'reservations:create': { auth: 'required', capability: 'reservations.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: true,  validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN',
                           notes: 'Deliberately unscoped: any marketer may book any guest, and protection is the only gate.' },
  'reservations:update': { auth: 'required', capability: 'reservations.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: true,  validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN',
                           notes: 'Retargeting re-validates existence, scope and protection — it is a create in disguise.' },
  'reservations:cancel': { auth: 'required', capability: 'reservations.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  destructive: true,  audit: true,  denial: 'FORBIDDEN',
                           notes: 'Idempotent; a repeat submit does not rewrite the recorded reason.' },
  'reservations:delete': { auth: 'required', capability: 'reservations.delete', roles: ['ADMIN'],                      scope: 'record', protection: false, validation: true,  destructive: true,  audit: true,  denial: 'FORBIDDEN',
                           notes: 'Soft delete. Hard ADMIN check beyond the capability; requires a reason.' },

  // ----------------------------------------------------------- crmNotes
  'crmNotes:list':       { auth: 'required', capability: 'crm.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'crmNotes:create':     { auth: 'required', capability: 'crm.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN' },
  'crmNotes:update':     { auth: 'required', capability: 'crm.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  destructive: false, audit: true,  denial: 'FORBIDDEN' },
  'crmNotes:delete':     { auth: 'required', capability: 'crm.delete', roles: ['ADMIN','MANAGER'],             scope: 'record', protection: false, validation: true,  destructive: true,  audit: true,  denial: 'FORBIDDEN' },
  'crmNotes:bulkCreate': { auth: 'required', capability: 'crm.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN',
                           notes: 'The same note on each selected guest through crmNotes:create. A guest outside the caller\'s scope refuses the whole request; a missing guest is reported per row.' },

  // ----------------------------------------------------------- profiles
  'profiles:list':       { auth: 'required', capability: 'profiles.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query',  protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Other marketers\' guest and reservation counts are masked for MARKETING.' },
  'profiles:get':        { auth: 'required', capability: 'profiles.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'profiles:related':    { auth: 'required', capability: 'profiles.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'A profile\'s guest book is that marketer\'s book — own profile only for MARKETING.' },
  'profiles:create':     { auth: 'required', capability: 'profiles.create', roles: ['ADMIN','MANAGER'], scope: 'none', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN' },
  'profiles:update':     { auth: 'required', capability: 'profiles.update', roles: ['ADMIN','MANAGER'], scope: 'none', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN' },
  'profiles:delete':     { auth: 'required', capability: 'profiles.delete', roles: ['ADMIN','MANAGER'], scope: 'none', protection: false, validation: true, destructive: true,  audit: true, denial: 'FORBIDDEN',
                           notes: 'Archive, not destroy — historical Invited By attribution must stay readable.' },

  // -------------------------------------------------------------- users
  'users:list':          { auth: 'required', capability: 'users.read',   roles: ['ADMIN'], scope: 'none', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Projection never includes password_hash.' },
  'users:create':        { auth: 'required', capability: 'users.create', roles: ['ADMIN'], scope: 'none', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN' },
  'users:update':        { auth: 'required', capability: 'users.update', roles: ['ADMIN'], scope: 'none', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN',
                           notes: 'A role change or disable invalidates that user\'s session immediately.' },
  'users:delete':        { auth: 'required', capability: 'users.delete', roles: ['ADMIN'], scope: 'none', protection: false, validation: true, destructive: true, audit: true, denial: 'FORBIDDEN',
                           notes: 'Disable, not destroy; the last active administrator cannot be removed.' },

  // ----------------------------------------------------------- settings
  'settings:all':            { auth: 'required', capability: 'settings.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                               notes: 'Personal keys resolve to the caller\'s own choice.' },
  'settings:set':            { auth: 'required', capability: 'settings.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN',
                               notes: 'Personal keys are self-scoped; shared keys need settings.write.' },
  'settings:permissions':    { auth: 'required', capability: 'settings.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'settings:setPermissions': { auth: 'required', capability: 'settings.permissions.write', roles: ['ADMIN'], scope: 'none', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN',
                               notes: 'Only configurable capabilities move; ADMIN-only ones are silently ignored.' },

  // ------------------------------------------------------ notifications
  'notifications:list':        { auth: 'required', capability: 'notifications.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query',  protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'notifications:unreadCount': { auth: 'required', capability: 'notifications.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query',  protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                                 notes: 'Fails closed rather than answering 0 without a session.' },
  'notifications:markRead':    { auth: 'required', capability: 'notifications.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN',
                                 notes: 'A foreign id and a missing id answer identically.' },
  'notifications:markAllRead': { auth: 'required', capability: 'notifications.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query',  protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'notifications:delete':      { auth: 'required', capability: 'notifications.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true, destructive: true, audit: false, denial: 'FORBIDDEN' },

  // -------------------------------------------------- dashboard/calendar
  'dashboard:load':      { auth: 'required', capability: 'dashboard.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Active Marketing is included for ADMIN and MANAGER only.' },
  'calendar:month':      { auth: 'required', capability: 'calendar.read',  roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN' },
  'calendar:day':        { auth: 'required', capability: 'calendar.read',  roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN' },

  // -------------------------------------------------------------- audit
  'audit:list':          { auth: 'required', capability: 'audit.read', roles: ['ADMIN','MANAGER'], scope: 'none', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Read-only: there is deliberately no audit update or delete verb anywhere. Optional actorUserId filter; facets: true adds the distinct actions and actors for filter menus.' },

  // ----------------------------------------------------------- oversight
  'activity:feed':       { auth: 'required', capability: 'dashboard.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: "Everyone's work only with activity.team; otherwise the caller's own actions, whatever is asked. A scoped caller never sees the guest detail of work outside its own book." },
  'search:global':       { auth: 'required', capability: 'customers.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Partial, case-insensitive match over guests, CRM notes, reservations and profiles, through the same record scope as the lists; each section also needs its own read capability.' },
  'team:overview':       { auth: 'required', capability: 'team.control', roles: ['ADMIN'], scope: 'none', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Read-only summary. No non-admin role holds team.control until an administrator grants it.' },

  // ------------------------------------------------------------- export
  'export:run':          { auth: 'required', capability: 'export.run', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN',
                           notes: 'Scope applies to the dataset (an explicit ids selection is read through the same scope); CSV or .xlsx, the latter optionally with every CRM note on a second sheet (needs crm.read). The file path comes from a native Save dialog, never the renderer.' },
  'export:columns':      { auth: 'required', capability: 'export.run', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Column labels of a dataset for the export dialog. Needs the dataset\'s own read capability too.' },

  // ------------------------------------------------------------ reports
  'reports:monthlyPdf':  { auth: 'required', capability: 'reports.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN',
                           notes: 'Scoped like the lists: a marketer\'s report covers their own book and invitations. Rendered offscreen with JavaScript off, no network and a no-remote CSP; saved through a native dialog.' },

  // ------------------------------------------------------------- photos
  'photos:import':       { auth: 'required', capability: 'customers.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN',
                           notes: 'Opens a native picker in the main process; validates type, signature and size.' },
  'app:openDataFolder':  { auth: 'required', capability: 'backup.read',      roles: ['ADMIN','MANAGER'], scope: 'none', protection: false, validation: true, destructive: false, audit: true,
                           denial: 'FORBIDDEN',
                           notes: 'Opens the FIXED application data folder. Takes no arguments: the renderer supplies no path, so there is nothing to traverse. Uses shell.openPath, never a shell command or a URL.' },
  'photos:crop':         { auth: 'required', capability: 'customers.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: true, destructive: false, audit: true,
                           denial: 'FORBIDDEN',
                           notes: 'Crops an ALREADY-MANAGED photo by name plus a rectangle. No filesystem path and no image bytes cross the boundary; the rectangle is clamped to the real image.' },
  'photos:read':         { auth: 'required', capability: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: true, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'Resolves inside the managed photo directory only; traversal is refused.' },
  'photos:remove':       { auth: 'required', capability: 'customers.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: true, destructive: true, audit: true, denial: 'FORBIDDEN' },

  // ------------------------------------------------------------- backup
  'backup:list':         { auth: 'required', capability: 'backup.read',    roles: ['ADMIN'], scope: 'none', protection: false, validation: false, destructive: false, audit: false, denial: 'FORBIDDEN',
                           notes: 'A backup is a full database dump including credentials — ADMIN only, not configurable.' },
  'backup:create':       { auth: 'required', capability: 'backup.create',  roles: ['ADMIN'], scope: 'none', protection: false, validation: true, destructive: false, audit: true, denial: 'FORBIDDEN' },
  'backup:restore':      { auth: 'required', capability: 'backup.restore', roles: ['ADMIN'], scope: 'none', protection: false, validation: true, destructive: true, audit: true, denial: 'FORBIDDEN',
                           notes: 'Validates, stages, and only then switches; current data survives any failure.' },

  // ------------------------------------------------------------ updates
  'updates:check':       { auth: 'required', capability: null, roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, destructive: false, audit: false, denial: null,
                           notes: 'Network failure here must never affect anything else.' },
  'updates:install':     { auth: 'required', capability: 'backup.create', roles: ['ADMIN'], scope: 'none', protection: false, validation: false, destructive: false, audit: true, denial: 'FORBIDDEN',
                           notes: 'Blocked unless a verified pre-update backup exists.' },
};

const REQUIRES_SESSION = Object.entries(SURFACE).filter(([, v]) => !v.roles.includes('anon')).map(([k]) => k);
const FORBIDDEN_FOR_MARKETING = Object.entries(SURFACE).filter(([, v]) => !v.roles.includes('MARKETING')).map(([k]) => k);
const FORBIDDEN_FOR_MANAGER = Object.entries(SURFACE).filter(([, v]) => !v.roles.includes('MANAGER')).map(([k]) => k);
const RECORD_SCOPED = Object.entries(SURFACE).filter(([, v]) => v.scope === 'record').map(([k]) => k);
const PROTECTION_ENFORCING = Object.entries(SURFACE).filter(([, v]) => v.protection).map(([k]) => k);
const DESTRUCTIVE = Object.entries(SURFACE).filter(([, v]) => v.destructive).map(([k]) => k);
const MUST_AUDIT = Object.entries(SURFACE).filter(([, v]) => v.audit).map(([k]) => k);

module.exports = {
  SURFACE, REQUIRES_SESSION, FORBIDDEN_FOR_MARKETING, FORBIDDEN_FOR_MANAGER,
  RECORD_SCOPED, PROTECTION_ENFORCING, DESTRUCTIVE, MUST_AUDIT,
};
