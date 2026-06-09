/**
 * build.js — Rast Flow AI ZXP Paketleyici
 *
 * Kullanım:
 *   npm run build   → ZXP + dağıtım ZIP oluştur
 *   npm run cert    → Sadece self-signed sertifika oluştur
 */

const fs       = require('fs');
const path     = require('path');
const archiver = require('archiver');
const zxp      = require('zxp-sign-cmd');

// ── Yapılandırma ──
const ROOT        = path.resolve(__dirname, '..');
const DIST        = path.join(__dirname, 'dist');
const CERT_DIR    = path.join(__dirname, 'cert');
const CERT_FILE   = path.join(CERT_DIR, 'selfcert.p12');
const CERT_PASS   = 'RastFlowAI2026';
const MANIFEST    = path.join(ROOT, 'CSXS', 'manifest.xml');

const INCLUDE_DIRS  = ['client', 'host', 'CSXS', 'fonts', 'templates', 'lib'];
const INCLUDE_FILES = ['index.js'];
const EXCLUDE = ['.git', '.gitignore', 'node_modules', 'installer', '.claude',
                 'SESSION_REPORT.md', 'claude_prompts.md', '.DS_Store', 'Thumbs.db'];

function getVersion() {
  const xml = fs.readFileSync(MANIFEST, 'utf8');
  const m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
  return m ? m[1] : '1.0.0';
}

async function ensureCert() {
  if (fs.existsSync(CERT_FILE)) {
    console.log('✓ Sertifika mevcut:', CERT_FILE);
    return;
  }
  console.log('🔐 Self-signed sertifika oluşturuluyor…');
  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

  await zxp.selfSignedCert({
    country: 'TR',
    province: 'TR',
    org: 'BewoAI',
    name: 'Rast Flow AI',
    password: CERT_PASS,
    output: CERT_FILE
  });
  console.log('✓ Sertifika oluşturuldu:', CERT_FILE);
}

function prepareStaging(stagingDir) {
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  for (const dir of INCLUDE_DIRS) {
    const src = path.join(ROOT, dir);
    if (!fs.existsSync(src)) { console.log('  ⚠ Atlanıyor (yok):', dir); continue; }
    copyDirSync(src, path.join(stagingDir, dir));
    console.log('  ✓', dir);
  }
  for (const file of INCLUDE_FILES) {
    const src = path.join(ROOT, file);
    if (!fs.existsSync(src)) { console.log('  ⚠ Atlanıyor (yok):', file); continue; }
    fs.copyFileSync(src, path.join(stagingDir, file));
    console.log('  ✓', file);
  }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (EXCLUDE.includes(entry.name)) continue;
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const version = getVersion();

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  Rast Flow AI — ZXP Builder v' + version);
  console.log('═══════════════════════════════════════');
  console.log('');

  // 1) Sertifika
  await ensureCert();
  if (args.includes('--cert-only')) return;

  // 2) Staging
  const stagingDir = path.join(DIST, '_staging');
  console.log('\n📦 Dosyalar hazırlanıyor…');
  prepareStaging(stagingDir);

  // 3) ZXP imzala
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const zxpName = `RastFlowAI_v${version}.zxp`;
  const zxpPath = path.join(DIST, zxpName);
  if (fs.existsSync(zxpPath)) fs.unlinkSync(zxpPath);

  console.log('\n🔏 ZXP imzalanıyor…');
  await zxp.sign({
    input: stagingDir,
    output: zxpPath,
    cert: CERT_FILE,
    password: CERT_PASS
  });
  console.log('✓ ZXP oluşturuldu:', zxpPath);

  // 4) Dağıtım ZIP
  const zipName = `RastFlowAI_v${version}_Setup.zip`;
  const zipPath = path.join(DIST, zipName);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  console.log('\n📦 Dağıtım ZIP oluşturuluyor…');
  const zipStaging = path.join(DIST, '_zip_staging');
  prepareStaging(zipStaging);
  fs.copyFileSync(path.join(__dirname, 'install.bat'), path.join(zipStaging, 'install.bat'));
  fs.copyFileSync(path.join(__dirname, 'uninstall.bat'), path.join(zipStaging, 'uninstall.bat'));

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(zipStaging, false);
    archive.finalize();
  });

  fs.rmSync(zipStaging, { recursive: true, force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });

  // 5) Sonuç
  const zxpSize = (fs.statSync(zxpPath).size / 1048576).toFixed(1);
  const zipSize = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  console.log('');
  console.log('✅ Hazır!');
  console.log(`   📁 ${zxpName}  (${zxpSize} MB)`);
  console.log(`   📁 ${zipName}  (${zipSize} MB)`);
  console.log('');
}

main().catch(err => {
  console.error('❌ Hata:', err.message);
  process.exit(1);
});
