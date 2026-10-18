// Parse-check every .gs file and the client JS in Script.html with `node --check`; validate manifest.
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const SRC = path.join(__dirname, '..', 'src');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-check-'));
let n = 0;
for (const f of fs.readdirSync(SRC)) {
  if (f.endsWith('.gs')) {
    const p = path.join(tmp, f.replace(/\.gs$/, '.js')); fs.copyFileSync(path.join(SRC, f), p);
    execFileSync(process.execPath, ['--check', p], { stdio: 'inherit' }); console.log('  ✓ parses:', f); n++;
  }
  if (f.endsWith('.html')) {
    const html = fs.readFileSync(path.join(SRC, f), 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m, i = 0;
    while ((m = re.exec(html))) {
      const p = path.join(tmp, `${f}.${i++}.js`); fs.writeFileSync(p, m[1]);
      execFileSync(process.execPath, ['--check', p], { stdio: 'inherit' }); console.log(`  ✓ parses: ${f} <script> #${i}`); n++;
    }
    (html.match(/include\('([^']+)'\)/g) || []).forEach(x => { const name = x.match(/'([^']+)'/)[1];
      if (!fs.existsSync(path.join(SRC, name + '.html'))) throw new Error(`${f} includes missing ${name}.html`); });
  }
}
const man = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
if (/ANYONE/.test(man.webapp.access)) throw new Error('webapp.access must not be ANYONE/ANYONE_ANONYMOUS');
if (man.webapp.executeAs !== 'USER_DEPLOYING' || man.timeZone !== 'Asia/Kolkata' || man.runtimeVersion !== 'V8') throw new Error('manifest basics wrong');
console.log(`  ✓ appsscript.json valid: access=${man.webapp.access}, executeAs=${man.webapp.executeAs}, scopes=${man.oauthScopes.length}`);
console.log(`ALL ${n + 1} SYNTAX CHECKS PASSED`);
