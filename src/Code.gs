/**
 * Code.gs — web app entry point.
 *
 * Deploy > New deployment > Web app. Keep "Execute as: Me" and restrict "Who has access"
 * to "Only myself" or "Anyone within <your domain>". NEVER "Anyone" — the payload contains
 * customer names, emails and phone numbers.
 */

/** Web app GET handler: serves the dashboard shell; data loads via google.script.run. */
function doGet(e) {
  var cfg = getConfig_();
  if (!isViewerAllowed_()) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui;padding:40px;color:#333"><h2>Access denied</h2>' +
      '<p>Your account is not on this dashboard\'s viewer list. Ask the dashboard owner for access.</p></div>')
      .setTitle('Access denied');
  }
  var t = HtmlService.createTemplateFromFile('Index');
  t.title = cfg.DASHBOARD_TITLE;
  return t.evaluate()
    .setTitle(cfg.DASHBOARD_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT); // do not allow embedding elsewhere
}

/** Template helper: <?!= include('Styles') ?> */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Optional allow-list on top of the deployment access level (Script Property ALLOWED_VIEWERS).
 * Note: Session.getActiveUser() only returns the viewer's email when viewer and owner share a
 * Google Workspace domain (or viewer == owner). Outside that it is blank and access is denied.
 */
function isViewerAllowed_() {
  var allow = splitList_(getConfig_().ALLOWED_VIEWERS);
  if (!allow.length) return true;
  var me = '';
  try { me = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { me = ''; }
  var owner = '';
  try { owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) { owner = ''; }
  return !!me && (me === owner || allow.indexOf(me) !== -1);
}

function assertViewer_() {
  if (!isViewerAllowed_()) throw new Error('Access denied: your account is not on the viewer list.');
}

/** Dashboard URL for emails and the sheet menu ('' if not deployed). */
function getWebAppUrl_() {
  var cfg = getConfig_();
  if (cfg.WEBAPP_URL) return cfg.WEBAPP_URL;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}
