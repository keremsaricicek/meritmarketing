'use strict';
/* Main-process test harness: a real SQLite database in a temp directory.
 *
 * No browser, no Electron. These tests exercise the services directly, which is
 * where authorization and business rules actually live. Every suite gets its own
 * database and its own media directory, so suites cannot see each other's data
 * and can run in any order. Nothing here ever touches the real userData path —
 * a test that wrote to a live installation would be a data-loss bug.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const connection = require('../../src/main/database/connection');
const { SessionManager } = require('../../src/main/auth/session');
const authService = require('../../src/main/services/auth-service');

class TestApp {
  constructor(name = 'mmh-test') {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    this.paths = {
      root: this.root,
      database: path.join(this.root, 'data', 'merit-marketing.sqlite3'),
      photos: path.join(this.root, 'photos'),
      backups: path.join(this.root, 'backups'),
      logs: path.join(this.root, 'logs'),
    };
    for (const dir of [this.paths.photos, this.paths.backups, this.paths.logs]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = connection.open(this.paths.database);
    this.sessions = new SessionManager();
    this.auditLog = [];
  }

  /** Audit sink that also writes the real row, so audit queries have data. */
  audit(entry) {
    this.auditLog.push(entry);
    const session = this.sessions.get();
    this.db.prepare(`
      INSERT INTO audit_log (action, entity_type, entity_id, actor_user_id, actor_username, description, metadata, created_at)
      VALUES (@action, @entity_type, @entity_id, @actor_user_id, @actor_username, @description, @metadata, @created_at)`)
      .run({
        action: entry.action,
        entity_type: entry.entity_type ?? null,
        entity_id: entry.entity_id ?? null,
        actor_user_id: entry.actor_user_id ?? (session ? session.id : null),
        actor_username: entry.actor_username ?? (session ? session.username : null),
        description: entry.description ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        created_at: new Date().toISOString(),
      });
  }

  ctx() {
    return { db: this.db, sessions: this.sessions, audit: (e) => this.audit(e), paths: this.paths };
  }

  /** Create the first ADMIN, the way a real first run does. */
  async bootstrapAdmin(password = 'baseline-console-key') {
    await authService.setup(this.db,
      { username: 'admin', password, passwordConfirm: password, fullName: 'Administrator' },
      this.ctx());
    this.adminPassword = password;
    return this.loginAdmin();
  }

  async login(username, password) {
    this.sessions.end();
    return authService.login(this.db, { username, password }, this.ctx());
  }

  loginAdmin() { return this.login('admin', this.adminPassword); }

  /** Seed a profile + a MARKETING account bound to it. */
  async createMarketingUser({ username, profileName, password = 'profile-console-key' }) {
    const now = new Date().toISOString();
    const profileId = this.db.prepare(
      'INSERT INTO profiles (full_name, kind, employment_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(profileName, 'marketing', 'active', now, now).lastInsertRowid;
    const passwords = require('../../src/main/auth/passwords');
    const hash = await passwords.hash(password);
    const userId = this.db.prepare(`
      INSERT INTO users (username, password_hash, role, profile_id, full_name, active, created_at, updated_at)
      VALUES (?, ?, 'MARKETING', ?, ?, 1, ?, ?)`)
      .run(username, hash, profileId, profileName, now, now).lastInsertRowid;
    return { userId, profileId, username, password };
  }

  async createManagerUser({ username = 'manager', password = 'oversight-console-key' } = {}) {
    const now = new Date().toISOString();
    const passwords = require('../../src/main/auth/passwords');
    const hash = await passwords.hash(password);
    const userId = this.db.prepare(`
      INSERT INTO users (username, password_hash, role, full_name, active, created_at, updated_at)
      VALUES (?, ?, 'MANAGER', ?, 1, ?, ?)`)
      .run(username, hash, 'Operations Manager', now, now).lastInsertRowid;
    return { userId, username, password };
  }

  /** A marketing profile with no login attached — for attribution fixtures. */
  createProfile(fullName, { kind = 'marketing', status = 'active' } = {}) {
    const now = new Date().toISOString();
    return this.db.prepare(
      'INSERT INTO profiles (full_name, kind, employment_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(fullName, kind, status, now, now).lastInsertRowid;
  }

  close() {
    try { connection.close(this.db); } catch (_) { /* closing anyway */ }
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
  }
}

module.exports = { TestApp };
