// Render src/Index.html locally (includes resolved, mock google.script.run serving the test payload)
// in headless Chromium, exercise the UX, screenshot the overview, and fail on console errors.
// Usage: node test/render_preview.js /tmp/fd_out/payload.json   (needs playwright-core + chart.js in NODE_PATH)
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const SRC = path.join(__dirname, '..', 'src'), ROOT = path.join(__dirname, '..');
const payloadPath = process.argv[2] || '/tmp/fd_out/payload.json';
const reportPath = process.argv[3] || '/tmp/fd_out/report.html';
const chartPath = path.join(process.env.CHARTJS_DIR || process.cwd(), 'node_modules/chart.js/dist/chart.umd.min.js');
const exe = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);

const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const payload = fs.readFileSync(payloadPath, 'utf8');
const mock = `<script>window.__calls=[];window.google={script:{
  run:(function mk(ok,fail){return new Proxy({},{get:(t,k)=>k==='withSuccessHandler'?(f=>mk(f,fail)):k==='withFailureHandler'?(f=>mk(ok,f)):
    (()=>{window.__calls.push(k);setTimeout(()=>ok(${JSON.stringify(payload)}),250)})})})(),
  history:{replace:(s,p,h)=>{window.__hash=h},setChangeHandler:()=>{}},
  url:{getLocation:cb=>cb({hash:'',parameter:{},parameters:{}})}}};</script>`;
const html = read('Index.html')
  .replace(/<\?!= include\('([^']+)'\); \?>/g, (_, n) => (n === 'Script' ? mock : '') + read(n + '.html'))
  .replace(/<\?= title \?>/g, 'Signup Funnel · Success &amp; Drop-off Explorer');
const tmpHtml = '/tmp/fd_out/preview_index.html'; fs.writeFileSync(tmpHtml, html);

(async () => {
  const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [], net = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  // Serve the pinned CDN URL from the local npm copy (offline); SRI is still enforced by the browser.
  await p.route('https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(chartPath) }));
  p.on('request', r => { const u = r.url(); if (!/^(file|data|blob):/.test(u) && !u.startsWith('https://cdn.jsdelivr.net/npm/chart.js@4.5.1/')) net.push(u); });
  await p.goto('file://' + tmpHtml);
  await p.waitForSelector('#loader.hide', { state: 'attached', timeout: 10000 }); await p.waitForTimeout(900);
  const log = (...a) => console.log('  ', ...a);
  log('calls', await p.evaluate(() => window.__calls));
  log('Chart.js loaded (SRI ok):', await p.evaluate(() => typeof Chart !== 'undefined' && Chart.version));
  log('charts drawn:', await p.evaluate(() => ['cFunnel','cDrop','cPlat','cLogin','cPath','cCountry','cPlatStage','cTime'].filter(id => Chart.getChart(id)).length), '/ 8');
  log('last updated:', await p.$eval('#upd', e => e.innerText));
  log('kpis', await p.$$eval('.kpi', e => e.map(x => x.innerText.replace(/\n/g, ' | '))));
  log('nav', await p.$$eval('nav button', e => e.map(x => x.innerText.replace(/\n/g, ' '))).then(a => a.join(' · ')));
  await p.screenshot({ path: path.join(ROOT, 'preview.png'), fullPage: true });
  await p.click('.st[data-k="3"]'); await p.waitForTimeout(200);
  log('stage card 3 ->', await p.$eval('nav button.active', e => e.innerText.replace(/\n/g, ' ')), '|', await p.$eval('#sCnt', e => e.innerText), '| hash', await p.evaluate(() => window.__hash));
  await p.click('#sSeg button[data-v=pass]'); log('toggle passed ->', await p.$eval('#sCnt', e => e.innerText));
  await p.click('#sSeg button[data-v=all]'); log('toggle all ->', await p.$eval('#sCnt', e => e.innerText));
  await p.fill('#sSearch', 'gmail'); log('search "gmail" ->', await p.$eval('#sCnt', e => e.innerText));
  await p.click('th[data-k=sv]'); const a1 = await p.$eval('#utbl tbody tr td:nth-child(14)', e => e.innerText);
  await p.click('th[data-k=sv]'); const a2 = await p.$eval('#utbl tbody tr td:nth-child(14)', e => e.innerText);
  log('sort screen views desc/asc first =', a1, '/', a2);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#sCsv')]);
  const tmp = '/tmp/fd_out/t.csv'; await dl.saveAs(tmp); log('csv export', dl.suggestedFilename(), fs.readFileSync(tmp, 'utf8').split('\n').length - 1, 'rows'); fs.unlinkSync(tmp);
  await p.click('#sBack'); log('back ->', await p.$eval('nav button.active', e => e.innerText));
  await p.click('#sumtbl tr[data-t="s7"]'); log('summary row 7 ->', await p.$eval('#sCnt', e => e.innerText), '| note:', await p.$eval('#sNote', e => e.innerText.slice(0, 90)));
  await p.click('nav button[data-t=s2]'); log('tab 2 note:', await p.$eval('#sNote', e => e.innerText.replace(/\n/g, ' ').slice(0, 140)));
  await p.click('nav button[data-t=completed]'); log('completed ->', await p.$eval('#sCnt', e => e.innerText));
  await p.click('nav button[data-t=overview]');
  const box = await (await p.$('#cFunnel')).boundingBox();
  const pt = await p.evaluate(() => { const m = Chart.getChart('cFunnel').getDatasetMeta(1).data[0]; return { x: m.x - 3, y: m.y }; });
  await p.mouse.click(box.x + pt.x, box.y + pt.y); await p.waitForTimeout(200);
  log('funnel bar click ->', await p.$eval('nav button.active', e => e.innerText.replace(/\n/g, ' ')), '|', await p.$eval('#sCnt', e => e.innerText));
  await p.click('#btnRefresh'); await p.waitForSelector('#loader.hide', { state: 'attached' }); await p.waitForTimeout(500);
  log('refresh -> calls', await p.evaluate(() => window.__calls), '| still on', await p.$eval('nav button.active', e => e.innerText.replace(/\n/g, ' ')), '| charts', await p.evaluate(() => Object.keys(Chart.instances).length));
  // Email preview (aggregates only)
  if (fs.existsSync(reportPath)) { const q = await b.newPage({ viewport: { width: 760, height: 900 } }); await q.goto('file://' + reportPath); await q.screenshot({ path: path.join(ROOT, 'report-preview.png'), fullPage: true }); }
  log('CONSOLE ERRORS:', errs.length ? errs : 'none'); log('EXTERNAL REQUESTS:', net.length ? net : 'none');
  await b.close();
  if (errs.length || net.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
