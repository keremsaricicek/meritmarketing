'use strict';
/* The one place an audited action is recorded.
 *
 * There used to be two: main.js had the real sink, and the test harness had its
 * own copy. That is how the manager activity feed shipped with no producer —
 * the feed hangs off the audit sink, the harness's copy did not have it, and
 * every notification test therefore exercised a sink the product does not use.
 *
 * Anything that happens when something is audited belongs HERE, so that a test
 * driving the services drives the same code the application does.
 */

const notificationService = require('./notification-service');
const { nowIso } = require('../../shared/contracts/dates');

/**
 * @param {object} db      open database
 * @param {object} entry   { action, entity_type, entity_id, description, metadata }
 * @param {object|null} session  the acting session, or null for system actions
 * @param {function} onError called with (stage, error) — never throws onward
 */
function record(db, entry, session, onError = () => {}) {
  if (!db || !entry) return;

  try {
    db.prepare(`
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
        created_at: nowIso(),
      });
  } catch (err) {
    onError('audit.write-failed', err);
  }

  /* The activity feed hangs off the sink rather than off each verb, so a new
     verb joins the feed the moment it becomes auditable and nobody has to
     remember. A notification failing must never fail the business operation
     that produced it — the booking is the point, the bell is not. */
  try {
    notificationService.emitActivity(db, entry, session);
  } catch (err) {
    onError('notification.emit-failed', err);
  }
}

module.exports = { record };
