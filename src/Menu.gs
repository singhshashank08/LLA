/**
 * Menu.gs — custom menu in the bound spreadsheet (only appears for container-bound projects).
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Funnel Dashboard')
    .addItem('Open dashboard', 'menuOpenDashboard')
    .addItem('Refresh data cache', 'menuRefreshCache')
    .addSeparator()
    .addItem('Send test report (to me)', 'menuSendTestReport')
    .addItem('Send report now (to recipients)', 'menuSendReportNow')
    .addItem('Set report recipients…', 'menuSetRecipients')
    .addSeparator()
    .addItem('Install daily trigger', 'menuInstallTrigger')
    .addItem('Remove daily trigger', 'menuRemoveTriggers')
    .addItem('Show current settings', 'menuShowSettings')
    .addToUi();
}

function menuOpenDashboard() {
  var url = getWebAppUrl_();
  var ui = SpreadsheetApp.getUi();
  if (url) {
    var safe = escHtml_(url);
    var html = HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui;padding:8px 4px">' +
      '<p><a id="l" href="' + safe + '" target="_blank" rel="noopener">Open the dashboard in a new tab →</a></p>' +
      '<p style="color:#666;font-size:12px">If nothing opened, click the link above (your browser may block pop-ups).</p></div>' +
      '<script>try{window.open(' + JSON.stringify(url) + ',"_blank","noopener")}catch(e){}</script>')
      .setWidth(420).setHeight(130);
    ui.showModalDialog(html, 'Funnel dashboard');
  } else {
    // Not deployed yet: show the dashboard inside a large dialog (same code as the web app).
    var t = HtmlService.createTemplateFromFile('Index');
    t.title = getConfig_().DASHBOARD_TITLE;
    ui.showModalDialog(t.evaluate().setWidth(1400).setHeight(860), 'Funnel dashboard (preview — not deployed as a web app yet)');
  }
}

function menuRefreshCache() {
  clearDataCache();
  var p = getPayload_(true);
  SpreadsheetApp.getActive().toast(p.meta.rowCount + ' rows loaded' + (p.meta.skipped ? ', ' + p.meta.skipped + ' skipped' : '') + '.', 'Funnel Dashboard', 5);
}

function menuSendTestReport() { menuRun_(sendTestReport); }
function menuSendReportNow() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('Send report now', 'Send the report to all REPORT_RECIPIENTS now (even if already sent today)?', ui.ButtonSet.YES_NO);
  if (r === ui.Button.YES) menuRun_(function () { return sendDailyReport({ force: true }); });
}
function menuInstallTrigger() { menuRun_(installDailyTrigger); }
function menuRemoveTriggers() { menuRun_(removeTriggers); }

function menuSetRecipients() {
  var ui = SpreadsheetApp.getUi();
  var cur = getConfig_().REPORT_RECIPIENTS;
  var res = ui.prompt('Report recipients',
    'Comma-separated email addresses.\nCurrent: ' + (cur || '(none)'), ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var list = splitList_(res.getResponseText());
  var bad = list.filter(function (e) { return !isValidEmail_(e); });
  if (!list.length || bad.length) {
    ui.alert('Not saved', bad.length ? 'Invalid address(es): ' + bad.join(', ') : 'No addresses entered.', ui.ButtonSet.OK);
    return;
  }
  var domains = splitList_(getConfig_().ALLOWED_RECIPIENT_DOMAINS);
  var outside = domains.length ? list.filter(function (e) { return domains.indexOf(e.split('@')[1]) === -1; }) : [];
  setScriptProperty_('REPORT_RECIPIENTS', list.join(','));
  ui.alert('Saved', 'Recipients: ' + list.join(', ') +
    (outside.length ? '\n\nWarning: these are outside ALLOWED_RECIPIENT_DOMAINS and will be skipped: ' + outside.join(', ') : ''), ui.ButtonSet.OK);
}

function menuShowSettings() {
  var c = getConfig_();
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === TRIGGER_HANDLER; }).length;
  SpreadsheetApp.getUi().alert('Funnel Dashboard settings',
    'Sheet: ' + (c.SHEET_ID || '(this spreadsheet)') + ' / tab "' + c.SHEET_NAME + '"\n' +
    'Recipients: ' + (c.REPORT_RECIPIENTS || '(none)') + '\n' +
    'Report hour: ' + c.REPORT_HOUR + ':00 ' + tz_() + '\n' +
    'Daily trigger installed: ' + (triggers ? 'yes (' + triggers + ')' : 'no') + '\n' +
    'Attach CSV with contact details: ' + c.ATTACH_CSV + '\n' +
    'Allowed recipient domains: ' + (c.ALLOWED_RECIPIENT_DOMAINS || '(any)') + '\n' +
    'Viewer allow-list: ' + (c.ALLOWED_VIEWERS || '(deployment access level only)') + '\n' +
    'Web app URL: ' + (getWebAppUrl_() || '(not deployed)') + '\n' +
    'Last report: ' + (PropertiesService.getScriptProperties().getProperty(STATE_KEYS.LAST_DATE) || '(never)'),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuRun_(fn) {
  var ui = SpreadsheetApp.getUi();
  try {
    ui.alert('Funnel Dashboard', String(fn() || 'Done.'), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Funnel Dashboard — error', String(e && e.message || e), ui.ButtonSet.OK);
  }
}
