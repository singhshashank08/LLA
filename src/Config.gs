/**
 * Config.gs — central configuration.
 *
 * Every value below is a DEFAULT. Override any of them WITHOUT editing code via
 *   Apps Script editor > Project Settings (gear icon) > Script Properties
 * or, for recipients, the sheet menu "Funnel Dashboard > Set report recipients…".
 *
 * Property key               Meaning
 * -------------------------  --------------------------------------------------------------
 * SHEET_ID                   Spreadsheet ID holding the data. Leave blank when this project is
 *                            bound to the spreadsheet (Extensions > Apps Script) — the container
 *                            spreadsheet is used automatically.
 * SHEET_NAME                 Tab name with the funnel rows (default 'funnel_dropoffs').
 * REPORT_RECIPIENTS          Comma-separated email list for the daily report.
 * REPORT_HOUR                Hour of day (0-23, script time zone Asia/Kolkata) for the daily run.
 * DASHBOARD_TITLE            Title used in the web app and the email subject.
 * ATTACH_CSV                 'true' to attach a CSV of drop-offs (WITH CONTACT DETAILS) to the
 *                            daily email. Default false — keep it off unless every recipient is
 *                            authorised to see customer PII.
 * ALLOWED_RECIPIENT_DOMAINS  Optional comma list (e.g. 'example.com'). If set, the report is only
 *                            sent to addresses in these domains; others are dropped and logged.
 * ALLOWED_VIEWERS            Optional comma list of emails allowed to open the web app (checked in
 *                            doGet in addition to the deployment access level). Blank = rely on
 *                            the deployment access level only.
 * CACHE_SECONDS              Server-side cache lifetime for the parsed sheet (default 600).
 * WEBAPP_URL                 Optional override for the dashboard link in emails/menu (useful if
 *                            ScriptApp.getService().getUrl() returns blank or the /dev URL).
 *
 * Internal state keys written by the script (do not edit by hand unless resetting):
 *   LAST_REPORT_KPIS, LAST_REPORT_DATE
 */

var CONFIG_DEFAULTS = {
  SHEET_ID: '',
  SHEET_NAME: 'funnel_dropoffs',
  REPORT_RECIPIENTS: '',
  REPORT_HOUR: 9,
  DASHBOARD_TITLE: 'Signup Funnel · Success & Drop-off Explorer',
  ATTACH_CSV: false,
  ALLOWED_RECIPIENT_DOMAINS: '',
  ALLOWED_VIEWERS: '',
  CACHE_SECONDS: 600,
  WEBAPP_URL: ''
};

/** Funnel stage order (index + 1 === max_stage). Mirrors build.py STAGES. */
var STAGES = ['offer', 'plan', 'sim_type', 'personal', 'order', 'processing', 'confirmation', 'delivery'];

/** Human labels (shared by email + dashboard). */
var STAGE_LABELS = {
  offer: 'Offer', plan: 'Plan', sim_type: 'SIM type', personal: 'Personal info', order: 'Order',
  processing: 'Processing', confirmation: 'Confirmation', delivery: 'Delivery',
  contact: 'Contact (pSIM)', completed: 'Completed'
};

var STATE_KEYS = { LAST_KPIS: 'LAST_REPORT_KPIS', LAST_DATE: 'LAST_REPORT_DATE' };

/**
 * Effective configuration = defaults overlaid with Script Properties.
 * Types are coerced to match the default (number / boolean / string).
 * @return {Object}
 */
function getConfig_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var cfg = {};
  Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
    var def = CONFIG_DEFAULTS[k];
    var raw = Object.prototype.hasOwnProperty.call(props, k) ? String(props[k]).trim() : '';
    if (raw === '') { cfg[k] = def; return; }
    if (typeof def === 'number') {
      var n = Number(raw);
      cfg[k] = isFinite(n) ? n : def;
    } else if (typeof def === 'boolean') {
      cfg[k] = /^(true|1|yes|y|on)$/i.test(raw);
    } else {
      cfg[k] = raw;
    }
  });
  cfg.REPORT_HOUR = Math.min(23, Math.max(0, Math.floor(cfg.REPORT_HOUR)));
  cfg.CACHE_SECONDS = Math.min(21600, Math.max(30, Math.floor(cfg.CACHE_SECONDS)));
  return cfg;
}

/** Split a comma/semicolon/whitespace separated list into trimmed, de-duplicated, lower-cased items. */
function splitList_(s) {
  var seen = {};
  return String(s || '').split(/[,;\s]+/).map(function (x) { return x.trim().toLowerCase(); })
    .filter(function (x) { if (!x || seen[x]) return false; seen[x] = true; return true; });
}

function isValidEmail_(e) {
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(e);
}

/** Save a Script Property (used by the menu helpers). */
function setScriptProperty_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

/** Script time zone (manifest: Asia/Kolkata). */
function tz_() {
  return Session.getScriptTimeZone() || 'Asia/Kolkata';
}

/** Run from the editor to print the effective configuration (no secrets are stored here). */
function showConfig() {
  var cfg = getConfig_();
  Logger.log(JSON.stringify(cfg, null, 2));
  return cfg;
}
