/**
 * Report.gs — daily HTML email report + trigger management.
 *
 * - Charts are rendered as pure HTML/CSS table bars. No QuickChart / Google Charts image URLs or any
 *   other third-party service is used, so no data leaves Google.
 * - The email BODY contains aggregates only. Customer contact details are only included if
 *   ATTACH_CSV=true (CSV attachment), which is OFF by default.
 * - Day-over-day deltas compare against the KPIs stored by the previous scheduled run
 *   (Script Property LAST_REPORT_KPIS). Test sends never overwrite that baseline.
 */

var TRIGGER_HANDLER = 'dailyReportTrigger';

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/** Time-driven trigger handler (installed by installDailyTrigger). */
function dailyReportTrigger() {
  sendDailyReport();
}

/**
 * Refresh data and send the report to REPORT_RECIPIENTS.
 * @param {{test?:boolean, force?:boolean}=} opts  test: send only to you, mark [TEST], keep baseline.
 *                                                 force: send even if already sent today.
 * @return {string} status message
 */
function sendDailyReport(opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another report run is in progress; try again shortly.');
  try {
    var cfg = getConfig_();
    var today = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
    var props = PropertiesService.getScriptProperties();

    if (!opts.test && !opts.force && props.getProperty(STATE_KEYS.LAST_DATE) === today) {
      var skipMsg = 'Report already sent today (' + today + '); skipping. Use sendDailyReport({force:true}) to resend.';
      console.log(skipMsg);
      return skipMsg;
    }

    var recipients = opts.test ? testRecipient_(cfg) : resolveRecipients_(cfg);
    if (!recipients.length) throw new Error(opts.test
      ? 'Could not determine your email for the test send. Set REPORT_RECIPIENTS and try again.'
      : 'No valid recipients. Set REPORT_RECIPIENTS (menu: Funnel Dashboard > Set report recipients…).');

    var quota = MailApp.getRemainingDailyQuota();
    if (quota < recipients.length) throw new Error('MailApp daily quota exhausted (' + quota + ' left, need ' + recipients.length + ').');

    // Daily refresh: drop the cache and re-read the sheet (also warms the cache for viewers).
    clearDataCache();
    var payload = getPayload_(true);
    var prevRaw = props.getProperty(STATE_KEYS.LAST_KPIS);
    var prev = null;
    try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch (e) { prev = null; }

    var url = getWebAppUrl_();
    var html = buildReportHtml_(payload, prev, { url: url, title: cfg.DASHBOARD_TITLE, today: today, test: !!opts.test, csv: cfg.ATTACH_CSV });
    var text = buildReportText_(payload, prev, { url: url, title: cfg.DASHBOARD_TITLE, today: today });
    var s = payload.stats;
    var subject = (opts.test ? '[TEST] ' : '') + cfg.DASHBOARD_TITLE + ' — ' + today + ' · ' +
      s.users + ' users · ' + s.converted + ' converted (' + pctTxt_(s.convRate) + ')';

    var mail = { to: recipients.join(','), subject: subject, htmlBody: html, body: text, name: 'Funnel Dashboard' };
    if (cfg.ATTACH_CSV) mail.attachments = [buildDropoffCsvBlob_(payload, today)];
    MailApp.sendEmail(mail);

    if (!opts.test) {
      props.setProperty(STATE_KEYS.LAST_KPIS, JSON.stringify(snapshot_(payload, today)));
      props.setProperty(STATE_KEYS.LAST_DATE, today);
    }
    var msg = 'Report sent to ' + recipients.length + ' recipient(s)' + (cfg.ATTACH_CSV ? ' with CSV attachment' : '') + '.';
    console.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** Send a [TEST] report to yourself only. Does not update the day-over-day baseline. */
function sendTestReport() {
  return sendDailyReport({ test: true });
}

/**
 * Create (or re-create) the single daily trigger at REPORT_HOUR (Asia/Kolkata). Idempotent:
 * existing triggers for the handler are removed first, so running it twice leaves exactly one.
 */
function installDailyTrigger() {
  var cfg = getConfig_();
  rememberBoundSheet_();
  removeTriggers();
  ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyDays(1).atHour(cfg.REPORT_HOUR).nearMinute(0)
    .inTimezone(tz_()).create();
  var msg = 'Daily trigger installed: ' + TRIGGER_HANDLER + ' every day ~' + ('0' + cfg.REPORT_HOUR).slice(-2) +
    ':00 ' + tz_() + ' (Apps Script runs it within that hour).';
  console.log(msg);
  return msg;
}

/** Remove this project's report triggers (only ones owned by the current user are visible). Idempotent. */
function removeTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TRIGGER_HANDLER) { ScriptApp.deleteTrigger(t); n++; }
  });
  var msg = 'Removed ' + n + ' trigger(s).';
  console.log(msg);
  return msg;
}

/** Forget the day-over-day baseline (next report shows no deltas). */
function resetReportBaseline() {
  var p = PropertiesService.getScriptProperties();
  p.deleteProperty(STATE_KEYS.LAST_KPIS);
  p.deleteProperty(STATE_KEYS.LAST_DATE);
  return 'Baseline cleared.';
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** If bound and SHEET_ID is unset, store the container ID so triggers/web app never lose it. */
function rememberBoundSheet_() {
  if (getConfig_().SHEET_ID) return;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) setScriptProperty_('SHEET_ID', ss.getId());
  } catch (e) { /* standalone: SHEET_ID must be set manually */ }
}

function resolveRecipients_(cfg) {
  var list = splitList_(cfg.REPORT_RECIPIENTS).filter(isValidEmail_);
  var domains = splitList_(cfg.ALLOWED_RECIPIENT_DOMAINS);
  if (!domains.length) return list;
  return list.filter(function (e) {
    var ok = domains.indexOf(e.split('@')[1]) !== -1;
    if (!ok) console.warn('Recipient ' + e + ' dropped: domain not in ALLOWED_RECIPIENT_DOMAINS.');
    return ok;
  });
}

function testRecipient_(cfg) {
  var me = '';
  try { me = Session.getEffectiveUser().getEmail(); } catch (e) { me = ''; }
  if (me && isValidEmail_(me.toLowerCase())) return [me];
  return resolveRecipients_(cfg).slice(0, 1);
}

function snapshot_(payload, today) {
  var s = payload.stats;
  return {
    date: today, at: payload.generatedIso, users: s.users, converted: s.converted, completed: s.completed,
    callTickets: s.callTickets, convRate: s.convRate,
    reached: s.stages.map(function (x) { return x.reached; }),
    dropped: s.stages.map(function (x) { return x.dropped; })
  };
}

function pctTxt_(x) { return x == null || !isFinite(x) ? '—' : (100 * x).toFixed(1) + '%'; }
function lbl_(s) { return STAGE_LABELS[s] || s; }
function escHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** Coloured delta badge. `pp` = percentage-point delta for rates. `goodUp` false = increase is bad. */
function deltaHtml_(cur, prev, opt) {
  opt = opt || {};
  if (prev == null || cur == null || !isFinite(prev)) return '<span style="color:#94a3b8;font-size:12px">n/a</span>';
  var d = cur - prev;
  var txt = opt.pp ? (d >= 0 ? '+' : '−') + Math.abs(100 * d).toFixed(1) + ' pp'
                   : (d >= 0 ? '+' : '−') + Math.abs(d).toLocaleString();
  if (Math.abs(d) < 1e-9) return '<span style="color:#64748b;font-size:12px">±0</span>';
  var good = opt.goodUp === false ? d < 0 : d > 0;
  return '<span style="color:' + (good ? '#15803d' : '#b91c1c') + ';font-size:12px;font-weight:600">' + txt + '</span>';
}

function buildReportHtml_(payload, prev, o) {
  var s = payload.stats, N = s.users;
  var F = 'font-family:Arial,Helvetica,sans-serif;';
  var th = 'style="' + F + 'padding:8px 10px;text-align:left;font-size:12px;color:#475569;border-bottom:2px solid #e2e8f0;background:#f8fafc"';
  var thr = 'style="' + F + 'padding:8px 10px;text-align:right;font-size:12px;color:#475569;border-bottom:2px solid #e2e8f0;background:#f8fafc"';
  var td = function (align, extra) { return 'style="' + F + 'padding:7px 10px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;text-align:' + (align || 'left') + ';' + (extra || '') + '"'; };
  var prevNote = prev ? 'vs previous report (' + escHtml_(prev.date) + ')' : 'first report — no previous run to compare';

  var kpi = function (label, value, delta, color) {
    return '<td width="25%" valign="top" style="' + F + 'padding:12px;border:1px solid #e2e8f0;background:#ffffff">' +
      '<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">' + label + '</div>' +
      '<div style="font-size:24px;font-weight:bold;color:' + color + ';margin:4px 0">' + value + '</div>' +
      '<div>' + delta + '</div></td>';
  };
  var worst = s.worstStage ? lbl_(s.worstStage) : '—';
  var worstIdx = STAGES.indexOf(s.worstStage);
  var nextLbl = worstIdx >= 0 && STAGES[worstIdx + 1] ? lbl_(STAGES[worstIdx + 1]) : 'completion';

  var rows = s.stages.map(function (x, i) {
    var wMoved = x.reached ? Math.round(100 * x.movedOn / x.reached) : 0;
    var wDrop = x.reached ? 100 - wMoved : 0;
    var barW = N ? Math.max(2, Math.round(160 * x.reached / N)) : 0;
    var bar = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="' + barW + '" style="border-collapse:collapse"><tr>' +
      (wMoved ? '<td width="' + wMoved + '%" style="background:#22c55e;height:10px;font-size:0;line-height:0">&nbsp;</td>' : '') +
      (wDrop ? '<td width="' + wDrop + '%" style="background:#f43f5e;height:10px;font-size:0;line-height:0">&nbsp;</td>' : '') +
      '</tr></table>';
    var pr = prev && prev.reached ? prev.reached[i] : null;
    return '<tr>' +
      '<td ' + td('left', 'white-space:nowrap') + '>' + x.k + '. ' + escHtml_(lbl_(x.stage)) + '</td>' +
      '<td ' + td('right') + '>' + x.reached + '</td>' +
      '<td ' + td('right', 'color:#15803d') + '>' + x.movedOn + '</td>' +
      '<td ' + td('right', 'color:#b91c1c') + '>' + x.dropped + '</td>' +
      '<td ' + td('right') + '>' + pctTxt_(x.stepConv) + '</td>' +
      '<td ' + td('right') + '>' + deltaHtml_(x.reached, pr) + '</td>' +
      '<td ' + td() + '>' + bar + '</td></tr>';
  }).join('');

  var dropOrder = ['plan', 'sim_type', 'personal', 'contact', 'order', 'processing', 'confirmation', 'delivery'];
  Object.keys(s.dropStage).forEach(function (k) { if (dropOrder.indexOf(k) === -1) dropOrder.push(k); });
  var dropMax = Math.max.apply(null, [1].concat(dropOrder.map(function (k) { return s.dropStage[k] || 0; })));
  var dropRows = dropOrder.filter(function (k) { return s.dropStage[k]; }).map(function (k) {
    var c = s.dropStage[k];
    return '<tr><td ' + td() + '>' + escHtml_(lbl_(k)) + '</td><td ' + td('right') + '>' + c + '</td>' +
      '<td ' + td() + '><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="' + Math.max(2, Math.round(200 * c / dropMax)) +
      '"><tr><td style="background:#fb7185;height:10px;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>';
  }).join('');

  var ld = s.latestDay;
  var button = o.url
    ? '<a href="' + escHtml_(o.url) + '" style="' + F + 'display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;font-size:14px">Open live dashboard →</a>'
    : '<span style="' + F + 'color:#64748b;font-size:12px">Dashboard link unavailable — deploy the web app or set Script Property WEBAPP_URL.</span>';

  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9"><tr><td align="center" style="padding:20px 10px">' +
    '<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;width:100%;background:#ffffff;border:1px solid #e2e8f0">' +
    '<tr><td style="' + F + 'background:#1e1b4b;color:#ffffff;padding:18px 22px">' +
      (o.test ? '<div style="font-size:11px;color:#fcd34d;font-weight:bold">TEST SEND — baseline not updated</div>' : '') +
      '<div style="font-size:19px;font-weight:bold">' + escHtml_(o.title) + '</div>' +
      '<div style="font-size:12px;color:#c7d2fe;margin-top:4px">Daily report · ' + escHtml_(o.today) + ' · data read ' + escHtml_(payload.generated) +
      ' · first seen ' + escHtml_(s.firstSeenMin) + ' → ' + escHtml_(s.firstSeenMax) + '</div></td></tr>' +

    '<tr><td style="padding:16px 22px 4px"><div style="' + F + 'font-size:12px;color:#64748b;margin-bottom:6px">Changes ' + prevNote + '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>' +
      kpi('Total users', N.toLocaleString(), deltaHtml_(N, prev && prev.users), '#4338ca') +
      kpi('Converted', s.converted.toLocaleString(), deltaHtml_(s.converted, prev && prev.converted), '#15803d') +
      kpi('Conversion rate', pctTxt_(s.convRate), deltaHtml_(s.convRate, prev && prev.convRate, { pp: true }), '#0e7490') +
      kpi('Completed (delivery)', s.completed.toLocaleString(), deltaHtml_(s.completed, prev && prev.completed), '#0f172a') +
      '</tr></table></td></tr>' +

    '<tr><td style="' + F + 'padding:12px 22px;font-size:13px;color:#0f172a">' +
      '<div style="background:#fff1f2;border:1px solid #fecdd3;padding:10px 12px">' +
      '<b>Top drop stage: ' + escHtml_(worst) + '</b> — ' + s.worstDropped + ' users (' + pctTxt_(N ? s.worstDropped / N : null) +
      ' of all) stopped here and never reached ' + escHtml_(nextLbl) + '.</div>' +
      (ld ? '<div style="margin-top:8px;color:#475569">Latest first-seen day <b>' + escHtml_(ld.date) + '</b>: ' + ld.users + ' new users, ' + ld.converted + ' converted (' + pctTxt_(ld.users ? ld.converted / ld.users : null) + '). ' +
        s.callTickets + ' call tickets overall.</div>' : '') +
    '</td></tr>' +

    '<tr><td style="padding:6px 22px 4px"><div style="' + F + 'font-size:15px;font-weight:bold;color:#0f172a;margin-bottom:6px">Stage funnel</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">' +
      '<tr><th ' + th + '>Stage</th><th ' + thr + '>Reached</th><th ' + thr + '>Moved on</th><th ' + thr + '>Dropped</th><th ' + thr + '>Step conv.</th><th ' + thr + '>Δ reached</th><th ' + th + '>Moved on / dropped</th></tr>' +
      rows + '</table>' +
      '<div style="' + F + 'font-size:11px;color:#64748b;margin-top:6px">Reached = max_stage ≥ stage. Moved on = went further (or completed at Delivery). Dropped = stopped at this stage, not completed. Step conv. = moved on ÷ reached.</div></td></tr>' +

    (dropRows ? '<tr><td style="padding:14px 22px 4px"><div style="' + F + 'font-size:15px;font-weight:bold;color:#0f172a;margin-bottom:6px">Next step not reached (drop_stage)</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">' + dropRows + '</table></td></tr>' : '') +

    '<tr><td align="left" style="padding:18px 22px">' + button + '</td></tr>' +
    '<tr><td style="' + F + 'padding:12px 22px 18px;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0">' +
      (o.csv ? '<b style="color:#b91c1c">The attached CSV contains customer contact details. Internal use only — do not forward outside the company.</b><br>' : 'This email contains aggregates only (no customer contact details). ') +
      'Generated automatically by the Funnel Dashboard Apps Script project from sheet "' + escHtml_(payload.meta.sheetName) + '".' +
      (payload.meta.skipped ? ' ' + payload.meta.skipped + ' malformed row(s) were skipped.' : '') +
    '</td></tr></table></td></tr></table></body></html>';
}

function buildReportText_(payload, prev, o) {
  var s = payload.stats;
  var d = function (c, p) { return p == null ? '' : ' (' + (c - p >= 0 ? '+' : '') + (c - p) + ')'; };
  var lines = [o.title + ' — daily report ' + o.today, '',
    'Total users: ' + s.users + d(s.users, prev && prev.users),
    'Converted: ' + s.converted + d(s.converted, prev && prev.converted) + ' · rate ' + pctTxt_(s.convRate),
    'Completed: ' + s.completed + d(s.completed, prev && prev.completed),
    'Top drop stage: ' + lbl_(s.worstStage) + ' (' + s.worstDropped + ')', '',
    'Stage | reached | moved on | dropped | step conv'];
  s.stages.forEach(function (x) {
    lines.push(x.k + '. ' + lbl_(x.stage) + ' | ' + x.reached + ' | ' + x.movedOn + ' | ' + x.dropped + ' | ' + pctTxt_(x.stepConv));
  });
  if (o.url) lines.push('', 'Dashboard: ' + o.url);
  return lines.join('\n');
}

/** CSV of every non-completed user grouped by the stage they stopped at (includes contact details). */
function buildDropoffCsvBlob_(payload, today) {
  var H = ['stopped_at_stage_no', 'stopped_at_stage', 'drop_stage', 'user_pseudo_id', 'name', 'email', 'phone', 'country_code',
    'platform', 'login_method', 'path', 'outcome', 'last_funnel_screen', 'first_seen_date', 'last_event_date', 'screen_views', 'active_days'];
  var q = function (v) {
    v = v == null ? '' : String(v);
    if (/^[=@\t\r]/.test(v) || /^[+-](?!\d)/.test(v)) v = "'" + v; // spreadsheet formula-injection guard
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  var rows = payload.rows.filter(function (r) { return !r.done; }).sort(function (a, b) {
    return a.ms - b.ms || (a.le < b.le ? 1 : a.le > b.le ? -1 : 0);
  });
  var lines = [H.join(',')].concat(rows.map(function (r) {
    return [r.ms, r.last, r.drop, r.id, r.name, r.email, r.phone, r.country, r.platform, r.login, r.path, r.outcome,
      r.lfs, r.fs, r.le, r.sv, r.ad].map(q).join(',');
  }));
  return Utilities.newBlob('\ufeff' + lines.join('\r\n'), 'text/csv', 'funnel_dropoffs_by_stage_' + today + '.csv');
}
