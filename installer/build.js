/**
 * build.js — Rast Flow AI ZXP Paketleyici
 *
 * Kullanım:
 *   npm run build          → ZXP oluştur (dist/RastFlowAI_v1.0.0.zxp)
 *   npm run cert           → Sadece self-signed sertifika oluştur
 *   npm run build --release→ GitHub Release'e yüklemek için hazır paket
 *
 * Gereklidir: npm install (archiver + zxp-sign-cmd)
 */

const fs       = require('fs');
const path     = require('path');
const archiver = require('archiver');
const { execSync } = require('child_process');

// ── Yapılandırma ──
const ROOT        = path.resolve(__dirname, '..');
const DIST        = path.join(__dirname, 'dist');
const CERT_DIR    = path.join(__dirname, 'cert');
const CERT_FILE   = path.join(CERT_DIR, 'selfcert.p12');
const CERT_PASS   = 'RastFlowAI2026';
const MANIFEST    = path.join(ROOT, 'CSXS', 'manifest.xml');

// ZXP'ye dahil edilecek klasörler ve dosyalar
const INCLUDE_DIRS  = ['client', 'host', 'CSXS', 'fonts', 'templates', 'lib'];
const INCLUDE_FILES = ['index.js'];
// Hariç tutulacaklar
const EXCLUDE = ['.git', '.gitignore', 'node_modules', 'installer', '.claude',
                 'SESSION_REPORT.md', 'claude_prompts.md', '.DS_Store', 'Thumbs.db'];

// ── Versiyon al ──
function getVersion() {
  const xml = fs.readFileSync(MANIFEST, 'utf8');
  const m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
  return m ? m[1] : '1.0.0';
}

// ── Self-signed sertifika oluştur ──
function ensureCert() {
  if (fs.existsSync(CERT_FILE)) {
    console.log('✓ Sertifika mevcut:', CERT_FILE);
    return;
  }
  console.log('🔐 Self-signed sertifika oluşturuluyor…');
  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

  // zxp-sign-cmd'nin binary yolunu bul
  const zxpBin = getZxpSignCmd();
  execSync(`"${zxpBin}" -selfSignedCert TR TR Istanbul BewoAI "Rast Flow AI" "${CERT_PASS}" "${CERT_FILE}"`, { stdio: 'inherit' });
  console.log('✓ Sertifika oluşturuldu:', CERT_FILE);
}

// ── zxp-sign-cmd binary yolu ──
function getZxpSignCmd() {
  // npm paketi olarak kurulduysa
  try {
    const pkg = require('zxp-sign-cmd');
    if (pkg && pkg.bin) return pkg.bin;
  } catch (e) {}

  // node_modules içinden doğrudan
  const candidates = [
    path.join(__dirname, 'node_modules', '.bin', 'ZXPSignCmd.exe'),
    path.join(__dirname, 'node_modules', '.bin', 'ZXPSignCmd'),
    path.join(__dirname, 'node_modules', 'zxp-sign-cmd', 'bin', 'ZXPSignCmd.exe'),
    path.join(__dirname, 'node_modules', 'zxp-sign-cmd', 'bin', 'ZXPSignCmd'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Sistem PATH'inde
  try {
    execSync('ZXPSignCmd -help', { stdio: 'pipe' });
    return 'ZXPSignCmd';
  } catch (e) {}

  throw new Error(
    'ZXPSignCmd bulunamadı. Çözüm:\n' +
    '  npm install   (zxp-sign-cmd paketi indirilecek)\n' +
    '  ya da https://github.com/niclas/zxp-sign-cmd adresinden indirin.'
  );
}

// ── Geçici klasörü hazırla (ZXP içeriği) ──
function prepareStaging(stagingDir) {
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  // Klasörleri kopyala
  for (const dir of INCLUDE_DIRS) {
    const src = path.join(ROOT, dir);
    if (!fs.existsSync(src)) { console.log('  ⚠ Atlanıyor (yok):', dir); continue; }
    copyDirSync(src, path.join(stagingDir, dir));
    console.log('  ✓', dir);
  }

  // Tek dosyaları kopyala
  for (const file of INCLUDE_FILES) {
    const src = path.join(ROOT, file);
    if (!fs.existsSync(src)) { console.log('  ⚠ Atlanıyor (yok):', file); continue; }
    fs.copyFileSync(src, path.join(stagingDir, file));
    console.log('  ✓', file);
  }
}

// ── Recursive copy ──
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

// ── ZXP imzala ──
function signZxp(stagingDir, outputZxp) {
  const zxpBin = getZxpSignCmd();
  console.log('🔏 ZXP imzalanıyor…');
  execSync(
    `"${zxpBin}" -sign "${stagingDir}" "${outputZxp}" "${CERT_FILE}" "${CERT_PASS}" -tsa http://timestamp.digicert.com`,
    { stdio: 'inherit' }
  );
  console.log('✓ ZXP oluşturuldu:', outputZxp);
}

// ── Ana akış ──
async function main() {
  const args = process.argv.slice(2);
  const version = getVersion();

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  Rast Flow AI — ZXP Builder v' + version);
  console.log('═══════════════════════════════════════');
  console.log('');

  // 1) Sertifika
  ensureCert();
  if (args.includes('--cert-only')) return;

  // 2) Staging
  const stagingDir = path.join(DIST, '_staging');
  console.log('\n📦 Dosyalar hazırlanıyor…');
  prepareStaging(stagingDir);

  // 3) ZXP oluştur
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const zxpName = `RastFlowAI_v${version}.zxp`;
  const zxpPath = path.join(DIST, zxpName);
  if (fs.existsSync(zxpPath)) fs.unlinkSync(zxpPath);

  signZxp(stagingDir, zxpPath);

  // 4) Dağıtım ZIP oluştur (install.bat + dosyalar + uninstall.bat)
  const zipName = `RastFlowAI_v${version}_Setup.zip`;
  const zipPath = path.join(DIST, zipName);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  console.log('\n📦 Dağıtım ZIP oluşturuluyor…');
  const zipStaging = path.join(DIST, '_zip_staging');
  prepareStaging(zipStaging);

  // install/uninstall scriptlerini ekle
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
  console.log(`   📁 ${zxpPath}  (${zxpSize} MB) — ZXP Installer ile kurulum`);
  console.log(`   📁 ${zipPath}  (${zipSize} MB) — ZIP aç + install.bat çift tıkla`);
  console.log('');
  console.log('GitHub Release: her iki dosyayı da release asset olarak yükleyin.');
  console.log('');
}

main().catch(err => {
  console.error('❌ Hata:', err.message);
  process.exit(1);
});
