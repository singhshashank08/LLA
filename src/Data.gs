/**
 * Data.gs — read the funnel sheet, normalise rows to the dashboard JSON shape
 * (identical to the original build.py output), compute stage stats, and cache.
 *
 * Row JSON (same keys as build.py):
 *   id,name,email,phone('+digits'),country,platform,login,path,outcome,ms(max_stage 1..8),
 *   last,drop,done,purch,esim(''|0|1),lfs,fs('yyyy-MM-dd'),le('yyyy-MM-dd'),sv,ad,imp,cfg,lang
 */

/** Sheet header -> how to read it. `req` columns must exist; others default to blank/0. */
var FIELD_MAP = [
  { key: 'id',      col: 'user_pseudo_id',         type: 'str',  req: true },
  { key: 'name',    col: 'name',                   type: 'str' },
  { key: 'email',   col: 'email',                  type: 'str' },
  { key: 'phone',   col: 'phone',                  type: 'phone' },
  { key: 'country', col: 'country_code',           type: 'str' },
  { key: 'platform',col: 'platform',               type: 'str' },
  { key: 'login',   col: 'login_method',           type: 'str' },
  { key: 'path',    col: 'path',                   type: 'str' },
  { key: 'outcome', col: 'outcome',                type: 'str',  req: true },
  { key: 'ms',      col: 'max_stage',              type: 'int',  req: true },
  { key: 'last',    col: 'last_stage',             type: 'str' },
  { key: 'drop',    col: 'drop_stage',             type: 'str' },
  { key: 'done',    col: 'completed',              type: 'bool', req: true },
  { key: 'purch',   col: 'purchased',              type: 'bool' },
  { key: 'esim',    col: 'got_esim',               type: 'intOrBlank' },
  { key: 'lfs',     col: 'last_funnel_screen',     type: 'str' },
  { key: 'fs',      col: 'first_seen_date',        type: 'date', req: true },
  { key: 'le',      col: 'last_event_date',        type: 'date' },
  { key: 'sv',      col: 'screen_views',           type: 'int' },
  { key: 'ad',      col: 'active_days',            type: 'int' },
  { key: 'imp',     col: 'personal_stage_imputed', type: 'int' },
  { key: 'cfg',     col: 'corrected_config',       type: 'str' },
  { key: 'lang',    col: 'user_language',          type: 'str' }
];

var CACHE_PREFIX = 'funnel_v1_';

/* ------------------------------------------------------------------ */
/* Public (callable from the client via google.script.run)            */
/* ------------------------------------------------------------------ */

/**
 * Dashboard payload as a JSON string (strings avoid google.script.run's Date/size quirks).
 * Served from cache when fresh (CACHE_SECONDS, default 10 min).
 * @return {string}
 */
function getDashboardData() {
  assertViewer_();
  return getPayloadJson_(false);
}

/** Same as getDashboardData() but bypasses the cache (Refresh button). */
function refreshDashboardData() {
  assertViewer_();
  return getPayloadJson_(true);
}

/* ------------------------------------------------------------------ */
/* Payload + cache                                                     */
/* ------------------------------------------------------------------ */

function getPayloadJson_(force) {
  var cfg = getConfig_();
  if (!force) {
    var hit = cacheGet_();
    if (hit) return hit;
  }
  var payload = buildPayload_(cfg);
  var json = asciiJson_(payload);
  cachePut_(json, cfg.CACHE_SECONDS);
  return json;
}

/** Parsed payload object (server-side use, e.g. Report.gs). */
function getPayload_(force) {
  return JSON.parse(getPayloadJson_(force));
}

function buildPayload_(cfg) {
  var ss = openSpreadsheet_(cfg);
  var sh = ss.getSheetByName(cfg.SHEET_NAME);
  if (!sh) throw new Error('Sheet tab "' + cfg.SHEET_NAME + '" not found in "' + ss.getName() +
    '". Set Script Property SHEET_NAME to the correct tab name.');
  var values = sh.getDataRange().getValues();
  var sheetTz = (ss.getSpreadsheetTimeZone && ss.getSpreadsheetTimeZone()) || tz_();
  var parsed = normaliseValues_(values, sheetTz);
  var stats = computeStats_(parsed.rows, STAGES);
  var now = new Date();
  return {
    stages: STAGES,
    rows: parsed.rows,
    generated: Utilities.formatDate(now, tz_(), 'yyyy-MM-dd HH:mm') + ' IST',
    generatedIso: now.toISOString(),
    stats: stats,
    meta: {
      title: cfg.DASHBOARD_TITLE,
      sheetName: cfg.SHEET_NAME,
      spreadsheetName: ss.getName(),
      rowCount: parsed.rows.length,
      skipped: parsed.skipped,
      warnings: parsed.warnings.slice(0, 20),
      missingOptional: parsed.missingOptional
    }
  };
}

function openSpreadsheet_(cfg) {
  if (cfg.SHEET_ID) return SpreadsheetApp.openById(cfg.SHEET_ID);
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) throw new Error('No spreadsheet: set Script Property SHEET_ID (standalone project) ' +
    'or create this project from the sheet via Extensions > Apps Script.');
  return ss;
}

/** JSON with all non-ASCII escaped so chunk length (chars) == bytes for CacheService limits. */
function asciiJson_(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, function (c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

var CHUNK_SIZE = 90000; // CacheService max value is 100KB

function cachePut_(json, seconds) {
  try {
    var cache = CacheService.getScriptCache();
    var ver = String(new Date().getTime());
    var n = Math.ceil(json.length / CHUNK_SIZE);
    var items = {};
    for (var i = 0; i < n; i++) items[CACHE_PREFIX + ver + '_' + i] = json.substr(i * CHUNK_SIZE, CHUNK_SIZE);
    cache.putAll(items, seconds);
    // Manifest written last, so readers never see a half-written version.
    cache.put(CACHE_PREFIX + 'manifest', JSON.stringify({ ver: ver, n: n, len: json.length }), seconds);
  } catch (e) {
    console.warn('Cache put failed (continuing without cache): ' + e);
  }
}

function cacheGet_() {
  try {
    var cache = CacheService.getScriptCache();
    var m = cache.get(CACHE_PREFIX + 'manifest');
    if (!m) return null;
    m = JSON.parse(m);
    var keys = [];
    for (var i = 0; i < m.n; i++) keys.push(CACHE_PREFIX + m.ver + '_' + i);
    var got = cache.getAll(keys);
    var parts = [];
    for (var j = 0; j < keys.length; j++) {
      if (got[keys[j]] == null) return null; // a chunk was evicted
      parts.push(got[keys[j]]);
    }
    var json = parts.join('');
    return json.length === m.len ? json : null;
  } catch (e) {
    console.warn('Cache get failed: ' + e);
    return null;
  }
}

/** Drop the cached payload (menu item / daily job). */
function clearDataCache() {
  CacheService.getScriptCache().remove(CACHE_PREFIX + 'manifest');
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {Array<Array<*>>} values  getDataRange().getValues() — header row first.
 * @param {string} sheetTz          time zone used to render Date cells as yyyy-MM-dd.
 * @return {{rows:Object[], skipped:number, warnings:string[], missingOptional:string[]}}
 */
function normaliseValues_(values, sheetTz) {
  if (!values || values.length < 1) throw new Error('Sheet is empty — expected a header row.');
  var header = values[0].map(function (h) { return String(h == null ? '' : h).trim().toLowerCase(); });
  var idx = {};
  header.forEach(function (h, i) { if (h && !(h in idx)) idx[h] = i; });

  var missingReq = [], missingOptional = [];
  FIELD_MAP.forEach(function (f) {
    if (!(f.col in idx)) (f.req ? missingReq : missingOptional).push(f.col);
  });
  if (missingReq.length) throw new Error('Missing required column(s) in header: ' + missingReq.join(', ') +
    '. Found: ' + header.filter(String).join(', '));

  var rows = [], warnings = [], skipped = 0;
  for (var r = 1; r < values.length; r++) {
    var line = values[r];
    if (isBlankRow_(line)) continue;
    var o = {};
    for (var f = 0; f < FIELD_MAP.length; f++) {
      var fd = FIELD_MAP[f];
      var v = (fd.col in idx) ? line[idx[fd.col]] : '';
      o[fd.key] = convert_(v, fd.type, sheetTz);
    }
    if (!o.id || !(o.ms >= 1 && o.ms <= STAGES.length)) {
      skipped++;
      if (warnings.length < 50) warnings.push('Row ' + (r + 1) + ': skipped (missing user_pseudo_id or max_stage outside 1..' + STAGES.length + ')');
      continue;
    }
    if (!o.last) o.last = STAGES[o.ms - 1];
    if (o.last !== STAGES[o.ms - 1] && warnings.length < 50) {
      warnings.push('Row ' + (r + 1) + ': last_stage "' + o.last + '" does not match max_stage ' + o.ms);
    }
    rows.push(o);
  }
  return { rows: rows, skipped: skipped, warnings: warnings, missingOptional: missingOptional };
}

function isBlankRow_(line) {
  for (var i = 0; i < line.length; i++) if (line[i] !== '' && line[i] != null) return false;
  return true;
}

function isBlank_(v) {
  return v == null || v === '' || (typeof v === 'number' && isNaN(v)) ||
    (typeof v === 'string' && /^\s*(nan|null|none|n\/a)?\s*$/i.test(v));
}

function convert_(v, type, sheetTz) {
  switch (type) {
    case 'str': return isBlank_(v) ? '' : (v instanceof Date ? toYmd_(v, sheetTz) : String(v).trim());
    case 'int': return toInt_(v, 0);
    case 'intOrBlank': return isBlank_(v) ? '' : toInt_(v, '');
    case 'bool': return toBool_(v);
    case 'date': return toYmd_(v, sheetTz);
    case 'phone': return toPhone_(v);
  }
  return v;
}

function toInt_(v, dflt) {
  if (isBlank_(v)) return dflt;
  if (typeof v === 'boolean') return v ? 1 : 0;
  var n = Number(String(v).trim());
  if (!isFinite(n)) { var b = toBoolOrNull_(v); return b == null ? dflt : (b ? 1 : 0); }
  return Math.round(n);
}

function toBoolOrNull_(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return isNaN(v) ? null : v !== 0;
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^(true|t|yes|y|1|1\.0)$/.test(s)) return true;
  if (/^(false|f|no|n|0|0\.0)$/.test(s)) return false;
  return null;
}

function toBool_(v) { return toBoolOrNull_(v) === true; }

/** Phone like build.py: '+' + integer digits. Handles numbers, '1.8765e10', '+1 876-…', blanks. */
function toPhone_(v) {
  if (isBlank_(v)) return '';
  if (typeof v === 'number') return isFinite(v) ? '+' + Math.round(v).toFixed(0) : '';
  var s = String(v).trim();
  if (/^[+]?\d+(\.\d+)?e[+]?\d+$/i.test(s)) {
    var n = Number(s.replace(/^\+/, ''));
    return isFinite(n) ? '+' + Math.round(n).toFixed(0) : '';
  }
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  var digits = s.replace(/\D/g, '');
  return digits ? '+' + digits : '';
}

/** Any date-ish cell -> 'yyyy-MM-dd' ('' if blank/unparseable). */
function toYmd_(v, sheetTz) {
  if (isBlank_(v)) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, sheetTz, 'yyyy-MM-dd');
  if (typeof v === 'number') {
    if (v > 19000101 && v < 21001231) { var s8 = String(Math.round(v)); return s8.slice(0, 4) + '-' + s8.slice(4, 6) + '-' + s8.slice(6, 8); }
    // Sheets serial day number (days since 1899-12-30)
    var d = new Date(Math.round((v - 25569) * 86400000));
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  var p = new Date(s);
  return isNaN(p.getTime()) ? '' : Utilities.formatDate(p, sheetTz, 'yyyy-MM-dd');
}

/* ------------------------------------------------------------------ */
/* Stats (same definitions as the dashboard)                           */
/* ------------------------------------------------------------------ */

/**
 * reached(k) = ms >= k; movedOn(k) = ms > k, or (k is last stage and completed);
 * dropped(k) = ms == k and not completed.
 */
function computeStats_(rows, stages) {
  var K = stages.length, N = rows.length;
  var reached = [], moved = [], dropped = [];
  for (var i = 0; i < K; i++) { reached.push(0); moved.push(0); dropped.push(0); }
  var conv = 0, comp = 0, calls = 0, dropStage = {}, fsMin = '', fsMax = '', byDay = {};
  rows.forEach(function (r) {
    for (var k = 1; k <= K; k++) {
      if (r.ms >= k) reached[k - 1]++;
      if (r.ms > k || (k === K && r.done)) moved[k - 1]++;
      if (r.ms === k && !r.done) dropped[k - 1]++;
    }
    if (r.outcome === 'converted') conv++;
    if (r.outcome === 'call_ticket') calls++;
    if (r.done) comp++;
    if (r.drop && !r.done) dropStage[r.drop] = (dropStage[r.drop] || 0) + 1;
    if (r.fs) {
      if (!fsMin || r.fs < fsMin) fsMin = r.fs;
      if (!fsMax || r.fs > fsMax) fsMax = r.fs;
      var d = byDay[r.fs] || (byDay[r.fs] = { users: 0, converted: 0 });
      d.users++; if (r.outcome === 'converted') d.converted++;
    }
  });
  var st = stages.map(function (s, i) {
    return { stage: s, k: i + 1, reached: reached[i], movedOn: moved[i], dropped: dropped[i],
      stepConv: reached[i] ? moved[i] / reached[i] : null, ofTotal: N ? reached[i] / N : null };
  });
  var worst = st.filter(function (x) { return x.dropped > 0; })
    .sort(function (a, b) { return b.dropped - a.dropped; })[0] || null;
  return {
    users: N, converted: conv, completed: comp, callTickets: calls,
    convRate: N ? conv / N : 0, completionRate: N ? comp / N : 0,
    stages: st, worstStage: worst ? worst.stage : '', worstDropped: worst ? worst.dropped : 0,
    dropStage: dropStage, firstSeenMin: fsMin, firstSeenMax: fsMax,
    latestDay: fsMax ? { date: fsMax, users: byDay[fsMax].users, converted: byDay[fsMax].converted } : null
  };
}
