// Minimal Apps Script runtime mock for local testing of the .gs files in Node (no network, no Google).
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'src');

function fmtDate(d, tz, pat) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return pat.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
}

function createGas({ values, sheetName = 'funnel_dropoffs', props = {}, sheetTz = 'Asia/Kolkata', user = 'owner@example.com', activeUser }) {
  const store = { props: { ...props }, cache: {}, mails: [], triggers: [], cacheMaxValue: 100 * 1024 };
  const range = { getValues: () => values.map(r => r.slice()) };
  const sheet = { getDataRange: () => range };
  const ss = { getSheetByName: n => (n === sheetName ? sheet : null), getName: () => 'Mock Funnel', getId: () => 'MOCK_SHEET_ID',
    getSpreadsheetTimeZone: () => sheetTz, toast: () => {} };
  const propsSvc = {
    getProperties: () => ({ ...store.props }), getProperty: k => (k in store.props ? store.props[k] : null),
    setProperty: (k, v) => { store.props[k] = String(v); return propsSvc; }, deleteProperty: k => { delete store.props[k]; return propsSvc; },
    setProperties: (o) => { Object.assign(store.props, o); return propsSvc; }
  };
  const cache = {
    put: (k, v, t) => { if (Buffer.byteLength(v) > store.cacheMaxValue) throw new Error('Argument too large: value'); store.cache[k] = v; },
    putAll: (o, t) => Object.keys(o).forEach(k => cache.put(k, o[k], t)),
    get: k => (k in store.cache ? store.cache[k] : null),
    getAll: ks => Object.fromEntries(ks.filter(k => k in store.cache).map(k => [k, store.cache[k]])),
    remove: k => { delete store.cache[k]; }
  };
  const trigBuilder = (fn) => { const t = { fn }; const b = { timeBased: () => b, everyDays: d => (t.days = d, b), atHour: h => (t.hour = h, b),
    nearMinute: m => b, inTimezone: z => (t.tz = z, b), create: () => { const tr = { getHandlerFunction: () => fn, meta: t }; store.triggers.push(tr); return tr; } }; return b; };
  const ctx = {
    console: { log: () => {}, warn: () => {}, error: console.error },
    Logger: { log: () => {} },
    SpreadsheetApp: { openById: id => ss, getActiveSpreadsheet: () => ss, getActive: () => ss, getUi: () => { throw new Error('no UI in test'); } },
    PropertiesService: { getScriptProperties: () => propsSvc },
    CacheService: { getScriptCache: () => cache },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata', getActiveUser: () => ({ getEmail: () => (activeUser === undefined ? user : activeUser) }),
      getEffectiveUser: () => ({ getEmail: () => user }) },
    Utilities: { formatDate: fmtDate, newBlob: (data, type, name) => ({ data, type, name, getDataAsString: () => data, getName: () => name }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: m => store.mails.push(m) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/MOCK/exec' }), getProjectTriggers: () => store.triggers.slice(),
      deleteTrigger: t => { store.triggers = store.triggers.filter(x => x !== t); }, newTrigger: trigBuilder },
    HtmlService: {}
  };
  vm.createContext(ctx);
  for (const f of fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, store };
}

/** Convert fixture cells ({__date__}) to real Date objects interpreted in the sheet time zone. */
function hydrate(grid, offset = '+05:30') {
  return grid.map((r, i) => i === 0 ? r : r.map(c => (c && typeof c === 'object' && c.__date__) ? new Date(c.__date__ + offset) : c));
}
module.exports = { createGas, hydrate, fmtDate };
