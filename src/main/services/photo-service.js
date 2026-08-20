'use strict';
/* Managed photo storage.
 *
 * Files live on disk under userData/photos and the database holds metadata.
 * Base64 blobs inside the database were the old approach; they bloat every
 * backup, every query that selects * and every row that crosses the IPC
 * boundary, for data that a filesystem already stores well.
 *
 * The renderer never sees or supplies a filesystem path. It asks to import
 * (a native picker opens in the main process) and later asks to read by the
 * managed name it was given.
 */

const fs = require('fs');
const crypto = require('crypto');
const { safeJoin } = require('../paths');
const guard = require('./guard');
const domain = require('./domain');
const customersRepo = require('../repositories/customers');
const { nowIso } = require('../../shared/contracts/dates');
const { validation, notFound } = require('../../shared/errors');

const MAX_BYTES = 5 * 1024 * 1024;

/* Content sniffing, not extension trust. A file named .png that begins with
   "MZ" is a Windows executable, and the extension is the attacker's choice. */
const SIGNATURES = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.toString('hex', 0, 8) === '89504e470d0a1a0a' },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

function detect(buffer) {
  return SIGNATURES.find((s) => s.test(buffer)) || null;
}

function build({ dialog, paths, getWindow }) {
  return {
    /* The picker opens in the MAIN process. The renderer never receives the
       chosen path, only the managed name — so a compromised renderer cannot
       learn where anything is on disk. */
    async importPhoto(ctx) {
      const session = guard.requireCapability(ctx, 'customers.update');
      const result = await dialog.showOpenDialog(getWindow(), {
        title: 'Choose a photo',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (result.canceled || !result.filePaths.length) return null;

      const source = result.filePaths[0];
      const stat = fs.statSync(source);
      if (!stat.isFile()) throw validation('That is not a file.');
      if (stat.size > MAX_BYTES) throw validation('Image must be 5 MB or smaller.');
      if (stat.size === 0) throw validation('That file is empty.');

      const buffer = fs.readFileSync(source);
      const kind = detect(buffer);
      if (!kind) throw validation('Only JPG, PNG and WEBP images are supported.');

      /* The internal name is generated, never derived from the original
         filename — which is attacker-controlled text that must never become a
         path component. */
      const name = `photo_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${kind.ext}`;
      const target = safeJoin(paths.photos, name);
      if (!target) throw validation('Could not store that image.');
      if (fs.existsSync(target)) throw validation('Could not store that image.');
      fs.writeFileSync(target, buffer, { flag: 'wx' });

      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      ctx.db.prepare(`INSERT INTO photos (name, mime_type, byte_size, sha256, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?)`).run(name, kind.mime, buffer.length, sha256, nowIso(), session.id);
      ctx.audit({ action: 'PHOTO_IMPORT', entity_type: 'photo', description: `Imported ${kind.mime} image` });

      return { name, mimeType: kind.mime, byteSize: buffer.length, dataUrl: `data:${kind.mime};base64,${buffer.toString('base64')}` };
    },

    /* Reading resolves strictly inside the managed directory. `safeJoin`
       refuses traversal, so a crafted name cannot read the database file, a
       backup, or anything else on the machine. */
    read(ctx, { name }) {
      guard.requireCapability(ctx, 'customers.read');
      const row = ctx.db.prepare('SELECT * FROM photos WHERE name = ?').get(String(name));
      if (!row) return null;
      const file = safeJoin(paths.photos, row.name);
      if (!file || !fs.existsSync(file)) return null;
      const buffer = fs.readFileSync(file);
      return { name: row.name, mimeType: row.mime_type, dataUrl: `data:${row.mime_type};base64,${buffer.toString('base64')}` };
    },

    /* A photo belongs to a guest, so deleting one is a write to that guest's
       record and needs the record scope, not only the capability. Holding
       `customers.update` answers "may this role edit guests"; it does not
       answer "may this session edit THIS guest". */
    remove(ctx, { name, customerId }) {
      guard.requireCapability(ctx, 'customers.update');
      const row = ctx.db.prepare('SELECT * FROM photos WHERE name = ?').get(String(name));
      if (!row) throw notFound('Photo not found.');

      /* Whoever the image is attached to is who authorizes its removal. A photo
         attached to nothing is management's to clear. */
      const owner = ctx.db.prepare(
        'SELECT * FROM customers WHERE photo_name = ? AND deleted_at IS NULL').get(row.name)
        || (customerId ? customersRepo.findById(ctx.db, Number(customerId)) : null);
      if (owner) guard.requireCustomerInScope(ctx, owner);
      else if (domain.scopeProfileId(ctx.sessions.get()) !== null) throw notFound('Photo not found.');

      const file = safeJoin(paths.photos, row.name);
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
      ctx.db.prepare('DELETE FROM photos WHERE name = ?').run(row.name);
      /* Clear the reference too, or the guest keeps pointing at a file that is
         gone and `photos.read` quietly returns null forever. */
      if (owner) {
        ctx.db.prepare('UPDATE customers SET photo_name = NULL WHERE photo_name = ?').run(row.name);
      }
      ctx.audit({ action: 'PHOTO_DELETE', entity_type: 'photo', description: `Removed image ${row.name}` });
      return { ok: true };
    },

    MAX_BYTES,
    detect,
  };
}

module.exports = { build, detect, MAX_BYTES };
