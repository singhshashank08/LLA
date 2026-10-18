// Node sanity tests: normalisation parity with build.py, stage counts, cache chunking, report + triggers.
// Usage: python3 test/export_fixture.py /workspace/data.xlsx /tmp/fd_fixture && node test/run_tests.js /tmp/fd_fixture
const fs = require('fs'), path = require('path'), assert = require('assert');
const { createGas, hydrate } = require('./gas_mock');
const FIX = process.argv[2] || '/tmp/fd_fixture';
const OUT = process.argv[3] || '/tmp/fd_out';
fs.mkdirSync(OUT, { recursive: true });
const typed = JSON.parse(fs.readFileSync(path.join(FIX, 'sheet_typed.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected_rows.json'), 'utf8'));
const EXP = { reached: [746, 429, 158, 106, 59, 35, 34, 20], dropped: [317, 271, 52, 47, 24, 1, 14, 0], converted: 36 };
let pass = 0; const ok = (m) => { pass++; console.log('  ✓ ' + m); };

function checkPayload(p, label) {
  assert.deepStrictEqual(p.stages, ['offer', 'plan', 'sim_type', 'personal', 'order', 'processing', 'confirmation', 'delivery']);
  assert.strictEqual(p.rows.length, expected.length, label + ' row count');
  const byId = Object.fromEntries(p.rows.map(r => [r.id, r]));
  let diffs = 0;
  expected.forEach(e => { try { assert.deepStrictEqual(byId[e.id], e); } catch (err) { if (diffs++ < 3) console.log('   diff', label, e.id, JSON.stringify(byId[e.id]), JSON.stringify(e)); } });
  assert.strictEqual(diffs, 0, label + ': rows differ from build.py output');
  ok(`${label}: all ${expected.length} rows identical to build.py mapping (all 23 fields)`);
  const s = p.stats;
  assert.deepStrictEqual(s.stages.map(x => x.reached), EXP.reached);
  assert.deepStrictEqual(s.stages.map(x => x.dropped), EXP.dropped);
  assert.strictEqual(s.converted, EXP.converted);
  ok(`${label}: reached ${s.stages.map(x => x.reached).join('/')} · dropped ${s.stages.map(x => x.dropped).join('/')} · converted ${s.converted}`);
}

console.log('1) Typed sheet (Dates, numeric phones, booleans) — like Range.getValues() on an imported xlsx');
const t1 = createGas({ values: hydrate(typed) });
const json1 = t1.ctx.getDashboardData();
assert.strictEqual(typeof json1, 'string');
const p1 = JSON.parse(json1);
checkPayload(p1, 'typed');
const chunks = Object.keys(t1.store.cache).filter(k => !k.endsWith('manifest')).length;
assert(chunks >= 2, 'expected chunked cache');
ok(`cache: payload ${json1.length} bytes stored in ${chunks} chunks (each ≤100KB)`);
t1.ctx.SpreadsheetApp.openById = () => { throw new Error('should be served from cache'); };
t1.ctx.SpreadsheetApp.getActiveSpreadsheet = t1.ctx.SpreadsheetApp.openById;
assert.strictEqual(t1.ctx.getDashboardData(), json1); ok('second call served from cache (sheet not read)');
fs.writeFileSync(path.join(OUT, 'payload.json'), json1);

console.log('2) Messy sheet: shuffled columns, everything as strings, mixed date/bool/phone formats, blank + bad rows');
const hdr = typed[0], order = hdr.map((_, i) => i).reverse();
const messy = typed.map((row, ri) => order.map(ci => {
  const c = row[ci], col = hdr[ci];
  if (ri === 0) return '  ' + String(c).toUpperCase() + ' ';                      // header case/whitespace
  if (c && typeof c === 'object' && c.__date__) {
    const ymd = c.__date__.slice(0, 10);
    return ri % 3 === 0 ? ymd : ri % 3 === 1 ? Number(ymd.replace(/-/g, '')) : ymd.replace(/-/g, '/') + ' 00:00:00';
  }
  if (typeof c === 'boolean') return ri % 2 ? (c ? 'TRUE' : 'FALSE') : (c ? 'true' : 'false');
  if (col === 'phone' && typeof c === 'number') return ri % 2 ? '+' + c.toFixed(0) : c.toFixed(0) + '.0';
  if (col === 'got_esim' && typeof c === 'number') return String(c) + (ri % 2 ? '.0' : '');
  if (typeof c === 'number') return String(c);
  return c === '' ? (ri % 5 === 0 ? 'NaN' : '') : c;
}));
messy.push(order.map(() => ''));                                          // blank row: ignored
const bad = order.map(() => ''); bad[order.indexOf(hdr.indexOf('user_pseudo_id'))] = 'BROKEN'; bad[order.indexOf(hdr.indexOf('max_stage'))] = '99';
messy.push(bad);                                                          // malformed: skipped
const t2 = createGas({ values: messy, props: { SHEET_ID: 'X' } });
const p2 = JSON.parse(t2.ctx.getDashboardData());
checkPayload(p2, 'messy');
assert.strictEqual(p2.meta.skipped, 1); ok('malformed row skipped and reported (meta.skipped=1); blank row ignored');

console.log('3) Missing required column -> clear error');
const t3 = createGas({ values: typed.map(r => r.filter((_, i) => hdr[i] !== 'max_stage')) });
assert.throws(() => t3.ctx.getDashboardData(), /Missing required column\(s\) in header: max_stage/); ok('descriptive error thrown');

console.log('4) Daily report, day-over-day, CSV flag, triggers');
const t4 = createGas({ values: hydrate(typed), props: { REPORT_RECIPIENTS: 'a@example.com, b@example.com, bad-address, c@other.org', ALLOWED_RECIPIENT_DOMAINS: 'example.com' } });
t4.ctx.sendTestReport();
assert.strictEqual(t4.store.mails.length, 1); assert.strictEqual(t4.store.mails[0].to, 'owner@example.com'); assert(/^\[TEST\]/.test(t4.store.mails[0].subject));
assert(!('LAST_REPORT_KPIS' in t4.store.props)); ok('sendTestReport -> only to owner, [TEST] subject, baseline untouched');
// previous run baseline (pretend yesterday had fewer users)
t4.store.props.LAST_REPORT_KPIS = JSON.stringify({ date: '2026-10-17', users: 700, converted: 30, completed: 18, callTickets: 5, convRate: 30 / 700,
  reached: [700, 400, 150, 100, 55, 33, 32, 18], dropped: [300, 250, 50, 45, 22, 1, 14, 0] });
t4.ctx.sendDailyReport();
const m = t4.store.mails[1];
assert.strictEqual(m.to, 'a@example.com,b@example.com'); ok('recipients validated + domain allow-list applied: ' + m.to);
assert(!m.attachments); ok('no attachment by default (ATTACH_CSV=false)');
assert(/\+46/.test(m.htmlBody) && /\+6/.test(m.htmlBody) && /pp/.test(m.htmlBody)); ok('day-over-day deltas rendered (+46 users, +6 converted, pp rate change)');
assert(/Top drop stage: Offer<\/b> — 317 users/.test(m.htmlBody)); ok('top drop stage: Offer (317)');
assert(m.htmlBody.includes('https://script.google.com/macros/s/MOCK/exec')); ok('web app link included');
assert(!/quickchart|chart\.googleapis|image-charts/i.test(m.htmlBody) && !/<img/i.test(m.htmlBody)); ok('no external chart/image URLs in email');
assert(!expected.some(r => r.email && m.htmlBody.includes(r.email))); ok('email body contains no customer emails');
const snap = JSON.parse(t4.store.props.LAST_REPORT_KPIS); assert.strictEqual(snap.users, 746); ok('baseline updated after scheduled send');
assert(/already sent today/.test(t4.ctx.sendDailyReport()) && t4.store.mails.length === 2); ok('duplicate same-day send suppressed');
fs.writeFileSync(path.join(OUT, 'report.html'), m.htmlBody);
t4.store.props.ATTACH_CSV = 'true';
t4.ctx.sendDailyReport({ force: true });
const att = t4.store.mails[2].attachments[0];
const lines = att.data.split('\r\n');
assert.strictEqual(lines.length - 1, 746 - 20); ok(`ATTACH_CSV=true -> ${att.name} with ${lines.length - 1} drop-off rows`);
t4.ctx.installDailyTrigger(); t4.ctx.installDailyTrigger();
assert.strictEqual(t4.store.triggers.length, 1); assert.strictEqual(t4.store.triggers[0].meta.hour, 9); assert.strictEqual(t4.store.triggers[0].meta.tz, 'Asia/Kolkata');
ok('installDailyTrigger idempotent (1 trigger, 09:00 Asia/Kolkata)');
assert.strictEqual(t4.store.props.SHEET_ID, 'MOCK_SHEET_ID'); ok('bound sheet ID remembered in Script Properties');
t4.ctx.removeTriggers(); t4.ctx.removeTriggers(); assert.strictEqual(t4.store.triggers.length, 0); ok('removeTriggers idempotent');

console.log('5) Viewer allow-list');
const t5 = createGas({ values: hydrate(typed), props: { ALLOWED_VIEWERS: 'x@example.com' }, activeUser: 'stranger@example.com' });
assert.throws(() => t5.ctx.getDashboardData(), /Access denied/); ok('non-listed viewer denied on google.script.run');
const t6 = createGas({ values: hydrate(typed), props: { ALLOWED_VIEWERS: 'x@example.com' }, activeUser: 'x@example.com' });
assert.strictEqual(JSON.parse(t6.ctx.getDashboardData()).rows.length, 746); ok('listed viewer allowed');

console.log(`\nALL ${pass} CHECKS PASSED`);
