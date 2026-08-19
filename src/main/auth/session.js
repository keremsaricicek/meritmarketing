'use strict';
/* The authenticated session — held in the privileged process, never in the page.
 *
 * The renderer gets a sanitized copy for rendering ("show the Users menu",
 * "greet me by name"). It never gets an object whose mutation means anything.
 * Every authorization decision reads the copy held here, so a renderer that has
 * been compromised by an XSS in a guest's name still cannot become an ADMIN by
 * assigning to a field.
 */

const { nowIso } = require('../../shared/contracts/dates');
const { can } = require('../../shared/contracts/roles');

class SessionManager {
  constructor({ idleTimeoutMs = 8 * 60 * 60 * 1000 } = {}) {
    this.current = null;
    this.idleTimeoutMs = idleTimeoutMs;
    this.lastActivityAt = null;
    this.permissionOverrides = {};
  }

  start(user) {
    this.current = Object.freeze({
      id: user.id,
      username: user.username,
      role: user.role,
      profile_id: user.profile_id ?? null,
      full_name: user.full_name || null,
      started_at: nowIso(),
    });
    this.lastActivityAt = Date.now();
    return this.current;
  }

  end() {
    this.current = null;
    this.lastActivityAt = null;
  }

  touch() {
    if (this.current) this.lastActivityAt = Date.now();
  }

  /* An idle session is ended rather than merely flagged: the point is that a
     workstation left unattended stops being able to read the guest book. */
  isExpired() {
    if (!this.current || !this.lastActivityAt) return false;
    return Date.now() - this.lastActivityAt > this.idleTimeoutMs;
  }

  get() {
    if (this.isExpired()) this.end();
    return this.current;
  }

  setPermissionOverrides(overrides) {
    this.permissionOverrides = overrides || {};
  }

  can(capability) {
    return can(this.get(), capability, this.permissionOverrides);
  }

  /* What the renderer is allowed to know about who is signed in. No password
     hash, no internal flags, and a capability list it can use to hide controls
     — hiding being a courtesy, never the boundary. */
  toWire(configurableCapabilities = []) {
    const s = this.get();
    if (!s) return null;
    const capabilities = {};
    for (const cap of configurableCapabilities) capabilities[cap] = this.can(cap);
    return {
      id: s.id,
      username: s.username,
      role: s.role,
      profile_id: s.profile_id,
      full_name: s.full_name,
      capabilities,
    };
  }

  /* Called when a user is disabled, has their role changed, or the permission
     matrix moves. Anything that could widen or narrow what the signed-in person
     may do has to take effect now, not at their next login. */
  invalidateIfAffected(userId) {
    if (this.current && this.current.id === userId) {
      this.end();
      return true;
    }
    return false;
  }
}

module.exports = { SessionManager };
