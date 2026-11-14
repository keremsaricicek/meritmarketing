'use strict';
/* The monthly PDF report.
 *
 * The numbers are gathered here with the same record scope as every list — a
 * marketer's report is a report on their own book and their own invitations —
 * and rendered from an HTML template built in the main process. Every value
 * that came from the database goes through escapeHtml before it is placed in
 * the template.
 *
 * The page is printed by an offscreen BrowserWindow that cannot do anything
 * but lay out that one file: JavaScript is off, it runs in its own in-memory
 * session that cancels every request except the local file, it cannot
 * navigate or open windows, and its Content-Security-Policy allows no remote
 * content at all. The file path comes from a native Save dialog, as with
 * export.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('./guard');
const domain = require('./domain');
const { validation } = require('../../shared/errors');
const { today, nowIso } = require('../../shared/contracts/dates');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function monthBounds(year, month) {
  const pad = (n) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first: `${year}-${pad(month)}-01`, last: `${year}-${pad(month)}-${pad(last)}`, days: last };
}

/* Nights of a stay that fall inside the month. */
function nightsInMonth(checkIn, checkOut, first, last) {
  const start = checkIn > first ? checkIn : first;
  const endExclusive = checkOut;
  const monthEndExclusive = new Date(Date.parse(`${last}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const end = endExclusive < monthEndExclusive ? endExclusive : monthEndExclusive;
  return Math.max(0, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000));
}

/** Everything the report shows, scoped to the caller. */
function monthlyData(ctx, { year, month }) {
  const session = guard.requireCapability(ctx, 'reports.read');
  guard.requireCapability(ctx, 'reservations.read');
  guard.requireCapability(ctx, 'customers.read');
  const { first, last } = monthBounds(year, month);
  const scopeId = domain.scopeProfileId(session);
  const db = ctx.db;
  const bind = (extra = {}) => (scopeId === null ? { first, last, ...extra } : { first, last, scopeId, ...extra });
  const resScope = scopeId === null ? '' : ' AND r.invited_by_profile_id = @scopeId';
  const guestScope = scopeId === null ? '' : ' AND c.marketing_profile_id = @scopeId';
  const canNotes = ctx.sessions.can('crm.read');

  /* Team performance: one row per marketing profile (only their own for a
     marketer). Invites are bookings MADE in the month; stays are bookings
     whose check-in falls in it; notes are CRM notes written by that profile's
     own accounts. */
  const profileScope = scopeId === null ? '' : ' AND p.id = @scopeId';
  const team = db.prepare(`
    SELECT p.id, p.full_name, p.employment_status,
      (SELECT COUNT(*) FROM reservations r WHERE r.deleted_at IS NULL AND r.invited_by_profile_id = p.id
         AND date(r.created_at,'localtime') BETWEEN @first AND @last) AS invites,
      (SELECT COUNT(*) FROM reservations r WHERE r.deleted_at IS NULL AND r.cancelled_at IS NULL
         AND r.invited_by_profile_id = p.id AND r.check_in BETWEEN @first AND @last) AS stays,
      (SELECT COUNT(*) FROM reservations r WHERE r.deleted_at IS NULL AND r.cancelled_at IS NOT NULL
         AND r.invited_by_profile_id = p.id AND r.check_in BETWEEN @first AND @last) AS cancelled,
      (SELECT COUNT(*) FROM crm_notes n JOIN users u ON u.id = n.created_by
         WHERE n.deleted_at IS NULL AND u.profile_id = p.id
           AND COALESCE(n.note_date, date(n.created_at,'localtime')) BETWEEN @first AND @last) AS notes,
      (SELECT COUNT(*) FROM customers c WHERE c.deleted_at IS NULL AND c.marketing_profile_id = p.id
         AND date(c.created_at,'localtime') BETWEEN @first AND @last) AS new_guests
    FROM profiles p
    WHERE COALESCE(p.kind,'marketing') = 'marketing'${profileScope}
    ORDER BY p.full_name COLLATE NOCASE`).all(bind())
    .filter((r) => r.employment_status === 'active' || r.invites || r.stays || r.notes || r.new_guests);

  const arrivals = db.prepare(`
    SELECT r.check_in, r.check_out, c.code, c.full_name, p.full_name AS invited_by
    FROM reservations r JOIN customers c ON c.id = r.customer_id
    LEFT JOIN profiles p ON p.id = r.invited_by_profile_id
    WHERE r.deleted_at IS NULL AND r.cancelled_at IS NULL AND r.check_in BETWEEN @first AND @last${resScope}
    ORDER BY r.check_in, c.full_name COLLATE NOCASE`).all(bind());

  const stays = db.prepare(`
    SELECT r.check_in, r.check_out FROM reservations r
    WHERE r.deleted_at IS NULL AND r.cancelled_at IS NULL
      AND r.check_in <= @last AND r.check_out >= @first${resScope}`).all(bind());
  const nights = stays.reduce((sum, r) => sum + nightsInMonth(r.check_in, r.check_out, first, last), 0);

  const newGuests = db.prepare(`
    SELECT c.code, c.full_name, c.created_at, p.full_name AS owner
    FROM customers c LEFT JOIN profiles p ON p.id = c.marketing_profile_id
    WHERE c.deleted_at IS NULL AND date(c.created_at,'localtime') BETWEEN @first AND @last${guestScope}
    ORDER BY c.created_at`).all(bind());

  /* Cold guests as of today, through the same list the screens use, so the
     report and the CRM panel agree on who is cold. */
  const cold = require('./customer-service').list(ctx, { status: 'COLD', registeredOnly: true, sort: 'last_visit', dir: 'asc', pageSize: 5000 });

  /* The guests talked about most this month, with the newest thing said. */
  const topNotes = canNotes ? db.prepare(`
    SELECT c.code, c.full_name, COUNT(*) AS note_count,
      (SELECT n2.note FROM crm_notes n2 WHERE n2.customer_id = c.id AND n2.deleted_at IS NULL
         AND COALESCE(n2.note_date, date(n2.created_at,'localtime')) BETWEEN @first AND @last
         ORDER BY COALESCE(n2.note_date, date(n2.created_at,'localtime')) DESC, n2.created_at DESC LIMIT 1) AS latest
    FROM crm_notes n JOIN customers c ON c.id = n.customer_id
    WHERE n.deleted_at IS NULL AND c.deleted_at IS NULL
      AND COALESCE(n.note_date, date(n.created_at,'localtime')) BETWEEN @first AND @last${guestScope}
    GROUP BY c.id ORDER BY note_count DESC, c.full_name COLLATE NOCASE LIMIT 10`).all(bind()) : null;

  const totals = {
    invites: team.reduce((s, r) => s + r.invites, 0),
    arrivals: arrivals.length,
    nights,
    notes: team.reduce((s, r) => s + r.notes, 0),
    newGuests: newGuests.length,
    cold: cold.total,
  };
  return {
    year, month, label: `${MONTHS[month - 1]} ${year}`, first, last,
    scoped: scopeId !== null, generatedAt: nowIso(), generatedBy: session.full_name || session.username,
    team, arrivals, newGuests, cold: { total: cold.total, rows: cold.rows.slice(0, 40) }, topNotes, totals,
  };
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'";

const STYLE = `
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1d1d1f; font-size: 10.5pt; margin: 0; }
  header { border-bottom: 2px solid #b08d3c; padding-bottom: 8px; margin-bottom: 14px; }
  h1 { font-size: 19pt; margin: 0; letter-spacing: .2px; }
  .sub { color: #666; font-size: 9.5pt; margin-top: 3px; }
  h2 { font-size: 12.5pt; margin: 18px 0 6px; color: #3a3220; break-after: avoid; }
  .kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
  .kpi { border: 1px solid #e3ddd0; border-radius: 6px; padding: 8px; background: #faf8f3; }
  .kpi b { display: block; font-size: 16pt; font-variant-numeric: tabular-nums; }
  .kpi span { color: #666; font-size: 8.5pt; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th { text-align: left; background: #f1ece1; padding: 5px 6px; font-weight: 600; }
  td { padding: 4px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
  tr { break-inside: avoid; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #777; }
  .empty { color: #777; font-style: italic; padding: 6px 0; }
  footer { margin-top: 20px; color: #888; font-size: 8.5pt; }
`;

function table(headers, rows, empty) {
  if (!rows.length) return `<div class="empty">${escapeHtml(empty)}</div>`;
  const head = headers.map((h) => `<th${h.n ? ' class="n"' : ''}>${escapeHtml(h.label)}</th>`).join('');
  const body = rows.map((cells) => `<tr>${cells.map((c, i) => `<td${headers[i].n ? ' class="n"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The report as a self-contained HTML document. */
function renderHtml(d) {
  const kpi = (value, label) => `<div class="kpi"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;
  const nf = (v) => String(v);
  const teamRows = d.team.map((r) => [r.full_name + (r.employment_status === 'active' ? '' : ' (inactive)'),
    nf(r.invites), nf(r.stays), nf(r.cancelled), nf(r.notes), nf(r.new_guests)]);
  const parts = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<title>Monthly report ${escapeHtml(d.label)}</title><style>${STYLE}</style></head><body>`,
    `<header><h1>Monthly report — ${escapeHtml(d.label)}</h1>`,
    `<div class="sub">${escapeHtml(d.first)} to ${escapeHtml(d.last)} · ${d.scoped ? 'Your own book' : 'Whole team'}`
      + ` · Generated ${escapeHtml(d.generatedAt.slice(0, 16).replace('T', ' '))} UTC by ${escapeHtml(d.generatedBy)}</div></header>`,
    '<section class="kpis">',
    kpi(d.totals.invites, 'Invites made'), kpi(d.totals.arrivals, 'Arrivals'), kpi(d.totals.nights, 'Guest nights'),
    kpi(d.totals.notes, 'CRM notes'), kpi(d.totals.newGuests, 'New guests'), kpi(d.totals.cold, 'Cold guests today'),
    '</section>',
    '<h2>Team performance</h2>',
    table([{ label: 'Marketing profile' }, { label: 'Invites', n: true }, { label: 'Stays', n: true },
      { label: 'Cancelled', n: true }, { label: 'Notes', n: true }, { label: 'New guests', n: true }],
    teamRows, 'No marketing profiles.'),
    `<h2>Arrivals in ${escapeHtml(d.label)} (${d.arrivals.length})</h2>`,
    table([{ label: 'Check in' }, { label: 'Check out' }, { label: 'Guest ID' }, { label: 'Guest' }, { label: 'Invited by' }],
      d.arrivals.map((r) => [r.check_in, r.check_out, `#${r.code}`, r.full_name, r.invited_by || '—']), 'No arrivals this month.'),
    `<h2>New guests (${d.newGuests.length})</h2>`,
    table([{ label: 'Registered' }, { label: 'Guest ID' }, { label: 'Guest' }, { label: 'Owner' }],
      d.newGuests.map((r) => [String(r.created_at).slice(0, 10), `#${r.code}`, r.full_name, r.owner || 'Unassigned']), 'No new guests this month.'),
  ];
  if (d.topNotes) {
    parts.push('<h2>Most discussed guests</h2>',
      table([{ label: 'Guest ID' }, { label: 'Guest' }, { label: 'Notes', n: true }, { label: 'Latest note' }],
        d.topNotes.map((r) => [`#${r.code}`, r.full_name, nf(r.note_count), r.latest || '']), 'No CRM notes this month.'));
  }
  parts.push(`<h2>Cold guests today (${d.cold.total})</h2>`,
    table([{ label: 'Guest ID' }, { label: 'Guest' }, { label: 'Owner' }, { label: 'Last visit' }, { label: 'Last note' }],
      d.cold.rows.map((r) => [`#${r.code}`, r.full_name, r.marketing_name || 'Unassigned', r.last_visit || '—', r.last_note_date || '—']),
      'No cold guests.'));
  if (d.cold.total > d.cold.rows.length) {
    parts.push(`<div class="muted">Showing the ${d.cold.rows.length} longest-cold of ${d.cold.total}. The full list is in Reports → Cold guests.</div>`);
  }
  parts.push('<footer>Merit Marketing Hub · confidential guest information</footer></body></html>');
  return parts.join('\n');
}

/* Prints a local HTML file in a window that can do nothing else. */
async function printHtml(electron, html) {
  const { BrowserWindow, session } = electron;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-report-'));
  const file = path.join(dir, 'report.html');
  fs.writeFileSync(file, html, 'utf8');
  const partition = `mmh-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ses = session.fromPartition(partition, { cache: false });
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !String(details.url).startsWith('file://') });
  });
  ses.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1400,
    webPreferences: {
      session: ses, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, images: false, spellcheck: false, devTools: false,
    },
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await win.loadFile(file);
    return await win.webContents.printToPDF({
      pageSize: 'A4', printBackground: true, preferCSSPageSize: true,
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function build({ dialog, getWindow, electron }) {
  return {
    async monthlyPdf(ctx, { year, month }) {
      const thisYear = Number(today().slice(0, 4));
      if (year > thisYear + 1) throw validation('Choose a month that has happened or is about to.', 'year');
      const data = monthlyData(ctx, { year, month });
      const pdf = await printHtml(electron || require('electron'), renderHtml(data));
      const suggested = `monthly-report_${data.first.slice(0, 7)}.pdf`;
      const result = await dialog.showSaveDialog(getWindow(), {
        title: 'Save monthly report',
        defaultPath: suggested,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return { cancelled: true };
      fs.writeFileSync(result.filePath, pdf);
      ctx.audit({
        action: 'REPORT_MONTHLY_PDF', entity_type: 'report',
        description: `Generated the monthly report for ${data.label}`,
        metadata: { month: data.first.slice(0, 7), scoped: data.scoped, ...data.totals },
      });
      return { cancelled: false, name: path.basename(result.filePath), label: data.label, bytes: pdf.length };
    },
  };
}

module.exports = { build, monthlyData, renderHtml, escapeHtml, monthBounds, nightsInMonth, CSP };
