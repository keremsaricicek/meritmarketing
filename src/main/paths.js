'use strict';
/* Where things live on disk.
 *
 * Application code and user data are kept strictly apart. The installer owns
 * the program directory and replaces it wholesale on update; if the database
 * lived there, every update would destroy the guest book. Everything the
 * business creates lives under Electron's userData path, which the installer
 * never touches.
 *
 * No Windows username is ever hard-coded — app.getPath('userData') resolves it.
 */

const path = require('path');
const fs = require('fs');

function resolve(app) {
  const root = app.getPath('userData');
  const paths = {
    root,
    data: path.join(root, 'data'),
    database: path.join(root, 'data', 'merit-marketing.sqlite3'),
    photos: path.join(root, 'photos'),
    backups: path.join(root, 'backups'),
    logs: path.join(root, 'logs'),
    state: path.join(root, 'state'),
    /* Written at startup and removed on a clean shutdown, so the next launch
       can tell whether the last one ended properly. */
    runningMarker: path.join(root, 'state', 'running.marker'),
  };
  for (const dir of [paths.data, paths.photos, paths.backups, paths.logs, paths.state]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/* Resolve a caller-supplied name INSIDE a directory, refusing anything that
   escapes it. This is the only way user input becomes a filesystem path
   anywhere in the application. `path.join` alone is not enough: join('/a/b',
   '../../etc/passwd') happily leaves the directory. */
function safeJoin(baseDir, name) {
  const base = path.resolve(baseDir);
  const candidate = path.resolve(base, String(name || ''));
  const rel = path.relative(base, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  /* Reject separators outright: managed names are flat, so a name containing
     one is either a mistake or an attempt. */
  if (/[\\/]/.test(String(name))) return null;
  return candidate;
}

module.exports = { resolve, safeJoin };
