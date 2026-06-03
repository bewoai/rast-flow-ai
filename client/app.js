/**
 * app.js — Rast Flow AI  |  Ana Uygulama Mantığı
 *
 * Modüller:
 *  A. APIManager     – Whisper API iletişimi + AES-256 şifreleme
 *  B. TranscriptStore – Kelime verisi yönetimi (CRUD)
 *  C. TranscriptEditor – Etkileşimli DOM editörü
 *  D. SilenceRemover  – Sessizlik tespiti + filler word hunter
 *  E. SubtitleEngine  – SRT üretimi + ExtendScript köprüsü
 *  F. UIController    – Tab, toast, stats, durum yönetimi
 */

'use strict';

/* ══════════════════════════════════════════════════════════════════
   A. APIManager  –  Whisper API + AES-256 API Key Şifreleme
   ══════════════════════════════════════════════════════════════════ */
const APIManager = (() => {
  const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
  const MODEL       = 'whisper-1';

  let _apiKey = '';

  /** Cihaza özgü AES-256 şifreleme anahtarı üret */
  function _getDeviceKey() {
    try {
      const crypto = require('crypto');
      const os     = require('os');
      const seed   = 'rastflowai-v1-' + os.hostname() + '-' + (os.userInfo ? os.userInfo().username : 'usr');
      return crypto.createHash('sha256').update(seed).digest();
    } catch (e) { return null; }
  }

  /** API Key'i AES-256-CBC ile şifrele */
  function _encrypt(plainText) {
    try {
      const crypto = require('crypto');
      const key    = _getDeviceKey();
      if (!key) return plainText; // crypto yoksa plain sakla
      const iv     = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let enc      = cipher.update(plainText, 'utf8', 'hex');
      enc         += cipher.final('hex');
      return 'ENC:' + iv.toString('hex') + ':' + enc;
    } catch (e) { return plainText; }
  }

  /** AES-256-CBC şifreli değeri çöz */
  function _decrypt(stored) {
    if (!stored || !stored.startsWith('ENC:')) return stored; // şifresiz eski değer
    try {
      const crypto = require('crypto');
      const key    = _getDeviceKey();
      if (!key) return '';
      const parts   = stored.split(':');
      const iv      = Buffer.from(parts[1], 'hex');
      const encHex  = parts[2];
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let dec        = decipher.update(encHex, 'hex', 'utf8');
      dec           += decipher.final('utf8');
      return dec;
    } catch (e) { return ''; }
  }

  /** Yalnızca yazdırılabilir ASCII karakterleri bırakır */
  function _sanitizeKey(k) {
    return String(k || '').replace(/[^\x21-\x7E]/g, '');
  }

  /** Config dosya yolu (~/.rastflowai/config.json) */
  function _configFile() {
    const path = require('path');
    const os   = require('os');
    return {
      dir : path.join(os.homedir(), '.rastflowai'),
      file: path.join(os.homedir(), '.rastflowai', 'config.json')
    };
  }

  /** Diske şifreli yaz */
  function _persist(obj) {
    try {
      const fs = require('fs');
      const { dir, file } = _configFile();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
      return;
    } catch (e) {}
    try { localStorage.setItem('rfai_cfg', JSON.stringify(obj)); } catch (e) {}
  }

  function _readConfig() {
    try {
      const fs = require('fs');
      const { file } = _configFile();
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {}
    try { return JSON.parse(localStorage.getItem('rfai_cfg') || '{}'); } catch (e) { return {}; }
  }

  /** API Key'i şifrele ve kalıcı olarak sakla */
  function setApiKey(key) {
    const clean = _sanitizeKey(key);
    if (!clean) return;
    _apiKey = clean;
    const cfg = _readConfig();
    cfg.apiKey = _encrypt(clean);   // ← AES-256 şifreli sakla
    _persist(cfg);
  }

  function getApiKey() {
    if (_apiKey) return _apiKey;
    const cfg = _readConfig();
    const raw = cfg.apiKey || '';
    _apiKey = _sanitizeKey(_decrypt(raw)); // ← şifreyi çöz
    return _apiKey;
  }

  function hasStoredKey() { return !!getApiKey(); }

  function maskApiKey(k) {
    if (!k || k.length < 8) return '••••••••';
    return k.slice(0, 4) + '•'.repeat(Math.max(0, k.length - 8)) + k.slice(-4);
  }

  /**
   * ExtendScript'ten ses dosyasını export et, ardından Whisper'a gönder.
   * @param {Function} onProgress (pct, msg)
   * @param {Object}   options    { useInOutOnly:boolean, language:string }
   * @returns {Promise<Array>} words dizisi
   */
  async function transcribe(onProgress, options) {
    options = options || {};
    const key = getApiKey();
    if (!key) throw new Error('API Key girilmemiş. Lütfen Ayarlar\'dan API Key girin.');

    const useInOutOnly = options.useInOutOnly === true;
    const language     = options.language || 'tr';

    onProgress && onProgress(5,
      useInOutOnly ? 'In/Out aralığı analiz ediliyor…' : 'Sekans analiz ediliyor…');

    const srcRaw = await _evalScript('getPrimarySourceForRange(' + (useInOutOnly ? 'true' : 'false') + ')');
    let src;
    try {
      src = JSON.parse(srcRaw);
    } catch (e) {
      throw new Error('Premiere Pro\'dan geçerli yanıt alınamadı. (CEP bağlantısını kontrol edin.)');
    }
    if (!src || !src.success) {
      throw new Error('Kaynak ses alınamadı: ' + (src ? src.error : 'bilinmeyen hata'));
    }

    const baseOffset = (typeof src.timelineStart === 'number') ? src.timelineStart : 0;

    onProgress && onProgress(15, 'Ses çıkarılıyor…');
    const filePath = await _extractAudio(src.path, src.srcStart, src.duration);

    const rangeMsg = src.mode === 'inout'
      ? `In/Out aralığı (${baseOffset.toFixed(2)}s – ${src.duration.toFixed(2)}s) Whisper'a gönderiliyor…`
      : 'Tüm sekans Whisper\'a gönderiliyor…';
    onProgress && onProgress(30, rangeMsg);

    const words = await _sendToWhisper(filePath, key, language, (p) => {
      onProgress && onProgress(30 + Math.round(p * 60), 'Transkript alınıyor…');
    });

    if (baseOffset > 0) {
      words.forEach(w => {
        w.start = parseFloat((w.start + baseOffset).toFixed(3));
        w.end   = parseFloat((w.end   + baseOffset).toFixed(3));
      });
    }

    try {
      if (typeof require === 'function') {
        const fs = require('fs');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (e) {}

    onProgress && onProgress(100, 'Tamamlandı.');
    return words;
  }

  async function _sendToWhisper(filePath, apiKey, language, onProgress) {
    return new Promise((resolve, reject) => {
      if (typeof require !== 'function') {
        reject(new Error(
          'Node.js entegrasyonu bulunamadı. ' +
          'manifest.xml içindeki --enable-nodejs parametresinin aktif olduğundan emin olun.'
        ));
        return;
      }
      try {
        const fs   = require('fs');
        const path = require('path');
        const https = require('https');

        const cleanKey = String(apiKey || '').replace(/[^\x21-\x7E]/g, '');
        if (!cleanKey || cleanKey.indexOf('•') >= 0) {
          reject(new Error('API Key geçersiz. Ayarlardan anahtarı tekrar yapıştırıp Kaydet\'e basın.'));
          return;
        }

        if (!fs.existsSync(filePath)) {
          reject(new Error('Export edilen ses dosyası bulunamadı: ' + filePath));
          return;
        }

        const fileBuffer = fs.readFileSync(filePath);
        const fileName   = path.basename(filePath);
        const boundary   = '----RastFlowAIBoundary' + Date.now();

        const parts = [];
        parts.push(_fieldPart('model', MODEL, boundary));
        parts.push(_fieldPart('response_format', 'verbose_json', boundary));
        parts.push(_fieldPart('timestamp_granularities[]', 'word', boundary));
        if (language && language !== 'auto') {
          parts.push(_fieldPart('language', language, boundary));
        }
        parts.push(_filePart(fileName, fileBuffer, boundary));

        const bodyEnd    = Buffer.from('\r\n--' + boundary + '--\r\n');
        const bodyBuffer = Buffer.concat(parts.concat([bodyEnd]));

        const reqOptions = {
          hostname: 'api.openai.com',
          path    : '/v1/audio/transcriptions',
          method  : 'POST',
          headers : {
            'Authorization': 'Bearer ' + cleanKey,
            'Content-Type' : 'multipart/form-data; boundary=' + boundary,
            'Content-Length': bodyBuffer.length
          }
        };

        const req = https.request(reqOptions, (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk.toString(); onProgress && onProgress(0.5); });
          res.on('end', () => {
            try {
              const data = JSON.parse(raw);
              if (data.error) {
                reject(new Error('Whisper API: ' + data.error.message));
                return;
              }

              let words = [];
              if (data.words && data.words.length > 0) {
                words = data.words.map(w => ({
                  word : w.word,
                  start: parseFloat(w.start),
                  end  : parseFloat(w.end),
                  id   : _uid()
                }));
              } else if (data.segments) {
                data.segments.forEach(seg => {
                  if (seg.words) {
                    seg.words.forEach(w => {
                      words.push({
                        word : w.word,
                        start: parseFloat(w.start),
                        end  : parseFloat(w.end),
                        id   : _uid()
                      });
                    });
                  }
                });
              }
              if (words.length === 0) {
                reject(new Error('Whisper kelime verisi döndürmedi. Ses dosyası boş veya sessiz olabilir.'));
                return;
              }
              words.forEach(w => { w.word = (w.word || '').trim(); });
              resolve(words);
            } catch (parseErr) {
              reject(new Error('API yanıtı işlenemedi: ' + parseErr.message));
            }
          });
        });

        req.on('error', (err) => reject(new Error('HTTPS hatası: ' + err.message)));
        req.write(bodyBuffer);
        req.end();

      } catch (e) {
        reject(new Error('Whisper isteği başarısız: ' + e.message));
      }
    });
  }

  function _fieldPart(name, value, boundary) {
    const str = '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
      value + '\r\n';
    return Buffer.from(str);
  }

  function _filePart(fileName, fileBuffer, boundary) {
    const header = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="' + fileName + '"\r\n' +
      'Content-Type: audio/wav\r\n\r\n'
    );
    return Buffer.concat([header, fileBuffer, Buffer.from('\r\n')]);
  }

  /* ── Ses Çıkarma ── */
  async function _extractAudio(srcPath, srcStart, duration) {
    if (typeof require !== 'function') {
      throw new Error('Node.js entegrasyonu yok. manifest.xml --enable-nodejs kontrol edin.');
    }
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');
    const cp   = require('child_process');

    const outWav = path.join(os.tmpdir(), 'rastflow_audio_' + Date.now() + '.wav');

    const ff = _findFfmpeg();
    if (ff) {
      try {
        await new Promise((resolve, reject) => {
          const args = [
            '-i', srcPath,
            '-ss', String(srcStart),
            '-t',  String(duration),
            '-vn', '-ac', '1', '-ar', '16000',
            '-c:a', 'pcm_s16le',
            '-y', outWav
          ];
          cp.execFile(ff, args, { maxBuffer: 1 << 28 }, (err) => {
            if (err) reject(new Error(err.message));
            else resolve();
          });
        });
        if (fs.existsSync(outWav) && fs.statSync(outWav).size > 0) return outWav;
      } catch (e) {}
    }

    return await _extractAudioWebAudio(srcPath, srcStart, duration, outWav);
  }

  function _findFfmpeg() {
    try {
      const fs   = require('fs');
      const path = require('path');
      const isWin = (navigator.platform || '').toLowerCase().indexOf('win') >= 0;
      const bin   = isWin ? 'ffmpeg.exe' : 'ffmpeg';

      let extRoot = '';
      try {
        const cs = window.getCSInterface ? window.getCSInterface() : null;
        if (cs) extRoot = cs.getSystemPath(window.SystemPath ? window.SystemPath.EXTENSION : 'extension');
      } catch (e) {}

      const candidates = [];
      if (extRoot) {
        candidates.push(path.join(extRoot, 'lib', 'ffmpeg', bin));
        candidates.push(path.join(extRoot, 'lib', bin));
      }
      for (const c of candidates) {
        try {
          if (fs.existsSync(c)) {
            if (!isWin) { try { fs.chmodSync(c, 0o755); } catch (e) {} }
            return c;
          }
        } catch (e) {}
      }
      return bin;
    } catch (e) { return null; }
  }

  async function _extractAudioWebAudio(srcPath, srcStart, duration, outWav) {
    const fs = require('fs');
    const buf = fs.readFileSync(srcPath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Ses çözücü kullanılamıyor ve FFmpeg bulunamadı.');

    const ctx = new AC();
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(arrayBuf);
    } catch (e) {
      try { ctx.close(); } catch (e2) {}
      throw new Error(
        'Bu medya biçimi yerleşik çözücüyle açılamadı. ' +
        'Hızlı çözüm için ffmpeg.exe dosyasını eklentinin lib/ffmpeg/ klasörüne ekleyin.'
      );
    }
    try { ctx.close(); } catch (e2) {}

    const targetSR = 16000;
    const inSR     = decoded.sampleRate;
    const startSample = Math.max(0, Math.floor(srcStart * inSR));
    const lenSample   = Math.min(decoded.length - startSample, Math.floor(duration * inSR));
    if (lenSample <= 0) throw new Error('Çıkarılacak ses örneği bulunamadı.');

    const chs  = decoded.numberOfChannels;
    const mono = new Float32Array(lenSample);
    for (let ch = 0; ch < chs; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < lenSample; i++) mono[i] += (data[startSample + i] || 0) / chs;
    }

    const offline = new OfflineAudioContext(1, Math.ceil(duration * targetSR), targetSR);
    const tmpBuf  = offline.createBuffer(1, lenSample, inSR);
    tmpBuf.copyToChannel(mono, 0);
    const node = offline.createBufferSource();
    node.buffer = tmpBuf;
    node.connect(offline.destination);
    node.start();
    const rendered = await offline.startRendering();

    fs.writeFileSync(outWav, Buffer.from(_encodeWav(rendered.getChannelData(0), targetSR)));
    return outWav;
  }

  function _encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, 'data'); view.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      o += 2;
    }
    return buffer;
  }

  function _evalScript(script) {
    return new Promise((resolve, reject) => {
      const cs = window.getCSInterface ? window.getCSInterface() : null;
      if (cs && typeof window.__adobe_cep__ !== 'undefined') {
        cs.evalScript(script, (result) => {
          if (result === 'EvalScript error.') reject(new Error('ExtendScript hatası: ' + script));
          else resolve(result || 'null');
        });
      } else {
        reject(new Error('Premiere Pro bağlantısı yok. Eklenti Premiere içinde çalışmıyor olabilir.'));
      }
    });
  }

  function _uid() { return Math.random().toString(36).slice(2, 9); }

  return { setApiKey, getApiKey, hasStoredKey, maskApiKey, transcribe };
})();


/* ══════════════════════════════════════════════════════════════════
   B. TranscriptStore  –  Kelime verisi yönetimi
   ══════════════════════════════════════════════════════════════════ */
const TranscriptStore = (() => {
  let _words     = [];
  let _segments  = [];
  let _listeners = [];

  function load(wordsArray) {
    _words    = wordsArray.map(w => ({ ...w, deleted: false, filler: false, repeat: false }));
    _segments = [];
    _notify();
  }

  function getWords(includeDeleted = false) {
    return includeDeleted ? [..._words] : _words.filter(w => !w.deleted);
  }

  function getSegments() { return [..._segments]; }

  function updateWord(id, newText) {
    const w = _words.find(x => x.id === id);
    if (w) { w.word = newText; _notify(); }
  }

  function deleteWord(id) {
    const w = _words.find(x => x.id === id);
    if (w) { w.deleted = true; _notify(); }
  }

  function restoreWord(id) {
    const w = _words.find(x => x.id === id);
    if (w) { w.deleted = false; _notify(); }
  }

  function markFiller(id, value) {
    const w = _words.find(x => x.id === id);
    if (w) { w.filler = value !== undefined ? value : !w.filler; _notify(); }
  }

  function markRepeat(id, value) {
    const w = _words.find(x => x.id === id);
    if (w) { w.repeat = value !== undefined ? value : !w.repeat; _notify(); }
  }

  function insertWordAfter(afterId, newText) {
    const idx = _words.findIndex(x => x.id === afterId);
    if (idx === -1) return;
    const prev = _words[idx];
    const next = _words[idx + 1];
    const midStart = prev.end;
    const midEnd   = next ? next.start : prev.end + 0.3;
    const duration = (midEnd - midStart) / 2;
    const newWord = {
      id     : _uid(),
      word   : newText,
      start  : parseFloat((midStart + duration * 0).toFixed(3)),
      end    : parseFloat((midStart + duration * 1).toFixed(3)),
      deleted: false, filler: false, repeat: false, virtual: true
    };
    _words.splice(idx + 1, 0, newWord);
    _notify();
    return newWord;
  }

  function addSegmentBreak(afterWordId) {
    if (!_segments.find(s => s.afterWordId === afterWordId)) {
      _segments.push({ afterWordId, id: _uid() });
      _notify();
    }
  }

  function removeSegmentBreak(afterWordId) {
    _segments = _segments.filter(s => s.afterWordId !== afterWordId);
    _notify();
  }

  function getSegmentedWords() {
    const active = _words.filter(w => !w.deleted);
    const segmentIds = new Set(_segments.map(s => s.afterWordId));
    const result = [];
    let current = [];
    for (let i = 0; i < active.length; i++) {
      current.push(active[i]);
      if (segmentIds.has(active[i].id)) {
        result.push([...current]);
        current = [];
      }
    }
    if (current.length) result.push(current);
    return result;
  }

  /** Silinecek aralıkları hesapla — komşu sessizliği de dahil eder */
  function getDeleteRanges() {
    const active  = _words.filter(w => !w.deleted);
    const deleted = _words.filter(w => w.deleted);
    const ranges  = [];

    for (const w of deleted) {
      // Silinmiş kelimenin önceki aktif kelimesini bul
      const prevActive = active.filter(x => x.end <= w.start).pop();
      // Sonraki aktif kelimesini bul
      const nextActive = active.find(x => x.start >= w.end);

      let start = w.start;
      let end   = w.end;

      // Önceki kelime ile arasındaki boşluğu da al (sessizlik payı)
      if (prevActive) {
        const gap = w.start - prevActive.end;
        if (gap > 0.02) start = prevActive.end + gap * 0.5; // yarısını al
      }
      // Sonraki kelime ile arasındaki boşluğu da al
      if (nextActive) {
        const gap = nextActive.start - w.end;
        if (gap > 0.02) end = w.end + gap * 0.5;
      }

      ranges.push({ start, end, wordId: w.id });
    }

    // Bitişik aralıkları birleştir
    ranges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const r of ranges) {
      if (merged.length && r.start <= merged[merged.length - 1].end + 0.05) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
      } else {
        merged.push({ ...r });
      }
    }
    return merged;
  }

  function onChange(fn) { _listeners.push(fn); }
  function notifyAll()  { _notify(); }
  function _notify()    { _listeners.forEach(fn => fn(_words, _segments)); }
  function _uid()       { return Math.random().toString(36).slice(2, 9); }

  return {
    load, getWords, getSegments, updateWord, deleteWord, restoreWord,
    markFiller, markRepeat, insertWordAfter,
    addSegmentBreak, removeSegmentBreak,
    getSegmentedWords, getDeleteRanges, onChange, notifyAll
  };
})();


/* ══════════════════════════════════════════════════════════════════
   C. TranscriptEditor  –  Etkileşimli DOM editörü
   ══════════════════════════════════════════════════════════════════ */
const TranscriptEditor = (() => {
  let _container    = null;
  let _contextMenu  = null;
  let _currentTime  = 0;

  function init(containerId) {
    _container = document.getElementById(containerId);

    _contextMenu = document.createElement('div');
    _contextMenu.className = 'word-context-menu';
    _contextMenu.style.display = 'none';
    document.body.appendChild(_contextMenu);

    document.addEventListener('click', _closeContextMenu);
    document.addEventListener('keydown', _onKeyDown);

    TranscriptStore.onChange(render);
  }

  function render(words, segments) {
    if (!_container) return;
    _container.innerHTML = '';

    if (!words || words.length === 0) {
      _container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎙️</div>
          <div class="empty-state-title">Henüz transkript yok</div>
          <div class="empty-state-desc">Yukarıdan transkript oluştur butonuna basın.</div>
        </div>`;
      return;
    }

    // Aktif sessizlik eşiğini oku (tek kaynak: silenceThreshold2)
    const silenceThreshold = _getSilenceThreshold();
    const segmentBreaks    = new Set((segments || []).map(s => s.afterWordId));
    const fragment         = document.createDocumentFragment();
    const activeWords      = words.filter(w => !w.deleted);

    activeWords.forEach((w, idx) => {
      // Sessizlik marker'ı
      if (idx > 0) {
        const prevActive = activeWords[idx - 1];
        const gap = w.start - prevActive.end;
        if (gap >= silenceThreshold) {
          const marker = document.createElement('span');
          marker.className      = 'silence-marker will-cut';
          marker.dataset.start  = prevActive.end;
          marker.dataset.end    = w.start;
          marker.dataset.dur    = gap.toFixed(2);
          marker.title          = `${gap.toFixed(2)}s sessizlik — tıkla: sil listesine ekle`;
          marker.addEventListener('click', _onSilenceMarkerClick);
          fragment.appendChild(marker);
        }
      }

      const span = document.createElement('span');
      span.className     = 'word';
      span.dataset.id    = w.id;
      span.dataset.start = w.start;
      span.dataset.end   = w.end;
      span.textContent   = w.word;

      if (w.filler)  span.classList.add('filler');
      if (w.repeat)  span.classList.add('repeat');
      if (w.virtual) span.title = 'Interpolasyon ile eklendi';

      span.addEventListener('click',       _onWordClick);
      span.addEventListener('dblclick',    _onWordDblClick);
      span.addEventListener('contextmenu', _onWordContextMenu);
      fragment.appendChild(span);

      if (segmentBreaks.has(w.id)) {
        const br = document.createElement('span');
        br.className       = 'segment-break';
        br.dataset.afterId = w.id;
        br.dataset.time    = _fmt(w.end);
        br.title           = 'Segment sonu — tıkla: kaldır';
        br.addEventListener('click', () => TranscriptStore.removeSegmentBreak(w.id));
        fragment.appendChild(br);
      }
    });

    _container.appendChild(fragment);
    _updatePlayingWord();
    UIController.updateStats();
  }

  function _onWordClick(e) {
    if (e.detail === 2) return;
    const span = e.currentTarget;
    const sec  = parseFloat(span.dataset.start);
    _currentTime = sec;
    _goToTime(sec);
    _updatePlayingWord();
  }

  function _onWordDblClick(e) {
    const span = e.currentTarget;
    const id   = span.dataset.id;
    const old  = span.textContent;

    span.innerHTML = '';
    const input = document.createElement('input');
    input.className = 'word-edit';
    input.type  = 'text';
    input.value = old;
    span.appendChild(input);
    input.focus();
    input.select();

    function commit() {
      const newVal = input.value.trim() || old;
      TranscriptStore.updateWord(id, newVal);
    }
    input.addEventListener('blur',   commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { span.textContent = old; }
    });
  }

  function _onWordContextMenu(e) {
    e.preventDefault();
    const span = e.currentTarget;
    const id   = span.dataset.id;
    const word = span.textContent;

    _contextMenu.innerHTML = `
      <div class="menu-item" data-action="goto">
        <span class="icon">▶</span> ${_fmt(parseFloat(span.dataset.start))} → git
      </div>
      <div class="menu-item" data-action="edit">
        <span class="icon">✎</span> Düzenle
      </div>
      <div class="menu-item" data-action="insert-before">
        <span class="icon">+</span> Önüne kelime ekle
      </div>
      <div class="menu-item" data-action="insert-after">
        <span class="icon">+</span> Sonrasına kelime ekle
      </div>
      <div class="menu-item" data-action="segment-break">
        <span class="icon">⏎</span> Burada segment böl
      </div>
      <div class="divider"></div>
      <div class="menu-item" data-action="mark-filler">
        <span class="icon">⚠</span> Filler olarak işaretle
      </div>
      <div class="menu-item danger" data-action="delete">
        <span class="icon">✕</span> Bu kelimeyi sil
      </div>`;

    _contextMenu.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', () => {
        _handleMenuAction(item.dataset.action, id, span, word);
        _closeContextMenu();
      });
    });

    _contextMenu.style.display = 'block';
    _contextMenu.style.left    = Math.min(e.clientX, window.innerWidth  - 170) + 'px';
    _contextMenu.style.top     = Math.min(e.clientY, window.innerHeight - 200) + 'px';
  }

  function _handleMenuAction(action, id, span, word) {
    switch (action) {
      case 'goto':
        _goToTime(parseFloat(span.dataset.start));
        break;
      case 'edit':
        span.dispatchEvent(new MouseEvent('dblclick'));
        break;
      case 'insert-before':
      case 'insert-after': {
        const text = prompt('Yeni kelime:');
        if (text && text.trim()) {
          const afterId = action === 'insert-after' ? id :
            (() => {
              const words = TranscriptStore.getWords();
              const idx   = words.findIndex(w => w.id === id);
              return idx > 0 ? words[idx - 1].id : null;
            })();
          if (afterId) TranscriptStore.insertWordAfter(afterId, text.trim());
        }
        break;
      }
      case 'segment-break':
        TranscriptStore.addSegmentBreak(id);
        break;
      case 'mark-filler':
        TranscriptStore.markFiller(id);
        break;
      case 'delete':
        TranscriptStore.deleteWord(id);
        break;
    }
  }

  function _onSilenceMarkerClick(e) {
    const start = parseFloat(e.currentTarget.dataset.start);
    const end   = parseFloat(e.currentTarget.dataset.end);
    UIController.addSilenceToDeleteList({ start, end });
    e.currentTarget.classList.add('queued');
    e.currentTarget.title = '✓ Silim listesine eklendi';
  }

  function _closeContextMenu() {
    if (_contextMenu) _contextMenu.style.display = 'none';
  }

  function _onKeyDown(e) {
    if (e.key === 'Enter' && document.activeElement === document.body) {
      const sel = document.querySelector('.word.selected');
      if (sel) TranscriptStore.addSegmentBreak(sel.dataset.id);
    }
  }

  function _updatePlayingWord(time) {
    if (time !== undefined) _currentTime = time;
    const words = _container?.querySelectorAll('.word');
    if (!words) return;
    words.forEach(span => {
      const s = parseFloat(span.dataset.start);
      const e = parseFloat(span.dataset.end);
      span.classList.toggle('playing', _currentTime >= s && _currentTime < e);
    });
  }

  function _goToTime(sec) {
    const cs = window.getCSInterface ? window.getCSInterface() : null;
    if (cs) { cs.evalScript('goToTime(' + sec + ')', () => {}); }
  }

  function _fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(2);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function _getSilenceThreshold() {
    const el = document.getElementById('silenceThreshold2') ||
               document.getElementById('silenceThreshold');
    return parseFloat(el?.value || 0.4);
  }

  return { init, render, updatePlayingWord: _updatePlayingWord };
})();


/* ══════════════════════════════════════════════════════════════════
   D. SilenceRemover  –  Sessizlik & Tekrar Tespiti
   ══════════════════════════════════════════════════════════════════ */
const SilenceRemover = (() => {
  const DEFAULT_FILLER = ['ıı', 'ıı ıı', 'şey', 'yani', 'ee', 'eee', 'hm', 'hmm',
                          'ah', 'aa', 'öö', 'mm', 'bir şey', 'yani şey', 'nasıl desem'];

  /**
   * Sessizlikleri tara — eşiği geçen boşlukları döndür.
   * @param {number} threshold  saniye (0.1 – 5.0)
   * @returns {Array} [{start, end, duration}]
   */
  function scanSilences(threshold) {
    const words    = TranscriptStore.getWords();
    const silences = [];

    for (let i = 1; i < words.length; i++) {
      const prev = words[i - 1];
      const curr = words[i];
      const gap  = parseFloat((curr.start - prev.end).toFixed(3));
      if (gap >= threshold) {
        silences.push({ start: prev.end, end: curr.start, duration: gap });
      }
    }
    return silences;
  }

  /**
   * Tekrarları tespit et — exact ve fuzzy mod.
   * @param {string} method 'exact' | 'fuzzy'
   */
  function findRepeats(method) {
    const words   = TranscriptStore.getWords();
    const repeats = [];

    // Önce tüm repeat işaretlerini sıfırla
    words.forEach(w => TranscriptStore.markRepeat(w.id, false));

    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i].word.toLowerCase().trim();
      const b = words[i + 1].word.toLowerCase().trim();

      let isRepeat = false;
      if (method === 'fuzzy') {
        isRepeat = a.length > 1 && b.length > 1 && _levenshtein(a, b) <= 2;
      } else {
        isRepeat = a === b && a.length > 1;
      }

      if (isRepeat) {
        TranscriptStore.markRepeat(words[i].id, true);
        repeats.push({ wordId: words[i].id, word: words[i].word });
      }
    }
    return repeats;
  }

  /** Levenshtein mesafesi (fuzzy matching için) */
  function _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
    );
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
    return dp[m][n];
  }

  function markFillers(fillerList) {
    const words = TranscriptStore.getWords();
    let count = 0;
    words.forEach(w => {
      const txt = w.word.toLowerCase().trim();
      if (fillerList.includes(txt)) {
        TranscriptStore.markFiller(w.id, true);
        count++;
      }
    });
    return count;
  }

  function deleteMarkedWords() {
    const words = TranscriptStore.getWords();
    words.forEach(w => {
      if (w.filler || w.repeat) TranscriptStore.deleteWord(w.id);
    });
  }

  /**
   * Sessizlikleri ve silinen kelimeleri ExtendScript'e gönder.
   * @param {Array}   ranges    [{start, end}]
   * @param {boolean} ripple    boşluk kapatılsın mı?
   */
  async function applyRippleDelete(ranges, ripple) {
    if (!ranges.length) return { success: true, deletedCount: 0 };

    // Çakışan ve bitişik aralıkları birleştir
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const merged = [];
    for (const r of sorted) {
      if (merged.length && r.start <= merged[merged.length - 1].end + 0.03) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
      } else {
        merged.push({ start: r.start, end: r.end });
      }
    }

    // Çok kısa aralıkları filtrele (< 50ms → atla)
    const valid = merged.filter(r => r.end - r.start >= 0.05);

    return new Promise((resolve, reject) => {
      const cs = window.getCSInterface ? window.getCSInterface() : null;
      const rangesJSON = JSON.stringify(valid);
      const rippleStr  = ripple === false ? 'false' : 'true';

      if (cs) {
        const script = `rippleDeleteRanges(${JSON.stringify(rangesJSON)}, '${rippleStr}')`;
        cs.evalScript(script, (result) => {
          try { resolve(JSON.parse(result)); }
          catch (e) { reject(e); }
        });
      } else {
        console.warn('[SilenceRemover] CEP yok. Simüle ediliyor.');
        setTimeout(() => resolve({ success: true, deletedCount: valid.length }), 600);
      }
    });
  }

  return { scanSilences, findRepeats, markFillers, deleteMarkedWords, applyRippleDelete, DEFAULT_FILLER };
})();


/* ══════════════════════════════════════════════════════════════════
   E. SubtitleEngine  –  SRT Altyazı Üretimi
   ══════════════════════════════════════════════════════════════════ */
const SubtitleEngine = (() => {
  let _style = {
    fontFamily    : 'Arial',
    fontSize      : 48,
    color         : '#FFFFFF',
    strokeWidth   : 2,
    strokeColor   : '#000000',
    shadowEnabled : true,
    highlightColor: '#FF6B3D',
    positionX     : 50,
    positionY     : 85
  };

  function getStyle()        { return { ..._style }; }
  function setStyle(updates) { Object.assign(_style, updates); _updatePreview(); }

  function _updatePreview() {
    const preview = document.getElementById('subtitlePreviewText');
    if (!preview) return;
    preview.style.fontFamily       = _style.fontFamily;
    preview.style.fontSize         = Math.round(_style.fontSize * 0.35) + 'px';
    preview.style.color            = _style.color;
    preview.style.webkitTextStroke = _style.strokeWidth + 'px ' + _style.strokeColor;
    preview.innerHTML = `Merhaba <span class="hl">dünya</span> bu bir test`;
  }

  /**
   * SRT dosyası oluştur ve Premiere'e aktar.
   */
  async function generateSubtitles() {
    const segmented = TranscriptStore.getSegmentedWords();
    if (segmented.length === 0) {
      throw new Error('Transkript boş. Önce transkript oluşturun.');
    }

    const segments = segmented.map(wordArr => ({
      text : wordArr.map(w => w.word).join(' '),
      start: wordArr[0].start,
      end  : wordArr[wordArr.length - 1].end,
      words: wordArr.map(w => ({ word: w.word, start: w.start, end: w.end }))
    }));

    const segmentsJSON = JSON.stringify(segments);

    return new Promise((resolve, reject) => {
      const cs = window.getCSInterface ? window.getCSInterface() : null;
      const script = `generateAndImportSRT(${JSON.stringify(segmentsJSON)}, '')`;

      if (cs) {
        cs.evalScript(script, (result) => {
          try {
            const res = JSON.parse(result);
            resolve(res);
          } catch (e) {
            reject(new Error('ExtendScript yanıtı işlenemedi: ' + e.message));
          }
        });
      } else {
        // Tarayıcı ortamı — SRT'yi indirilebilir dosya olarak sun
        _downloadSRTBrowser(segments);
        resolve({ success: true, srtPath: 'indirilen dosya', importedToProject: false });
      }
    });
  }

  /** Tarayıcı ortamında SRT'yi indir (geliştirme/test için) */
  function _downloadSRTBrowser(segments) {
    let srt = '';
    segments.forEach((seg, i) => {
      srt += (i + 1) + '\n';
      srt += _secsToSRTTime(seg.start) + ' --> ' + _secsToSRTTime(seg.end) + '\n';
      srt += seg.text + '\n\n';
    });
    const blob = new Blob([srt], { type: 'text/plain' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'rastflow_altyazi.srt';
    a.click();
  }

  function _secsToSRTTime(secs) {
    const ms  = Math.round((secs % 1) * 1000);
    const s   = Math.floor(secs) % 60;
    const m   = Math.floor(secs / 60) % 60;
    const h   = Math.floor(secs / 3600);
    const p2  = n => String(n).padStart(2, '0');
    const p3  = n => String(n).padStart(3, '0');
    return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`;
  }

  return { getStyle, setStyle, generateSubtitles };
})();


/* ══════════════════════════════════════════════════════════════════
   F. UIController  –  Ana UI Yöneticisi
   ══════════════════════════════════════════════════════════════════ */
const UIController = (() => {
  let _silenceDeleteList = [];
  let _fillerList = [...SilenceRemover.DEFAULT_FILLER];

  function init() {
    // Tab sistemi
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.panel).classList.add('active');
      });
    });

    // Sessizlik eşiği senkronizasyonu (iki input aynı değeri taşır)
    const th1 = document.getElementById('silenceThreshold');
    const th2 = document.getElementById('silenceThreshold2');
    if (th1 && th2) {
      th1.addEventListener('input', () => { th2.value = th1.value; TranscriptStore.notifyAll(); });
      th2.addEventListener('input', () => { th1.value = th2.value; TranscriptStore.notifyAll(); });
    }

    // API Key
    const keyInput = document.getElementById('apiKeyInput');
    const keySave  = document.getElementById('apiKeySave');
    const keyShow  = document.getElementById('apiKeyToggle');
    const apiDot   = document.getElementById('apiStatusDot');

    if (APIManager.hasStoredKey()) {
      const saved = APIManager.getApiKey();
      if (keyInput) keyInput.value = APIManager.maskApiKey(saved);
      if (apiDot) apiDot.className = 'status-dot ok';
    }

    if (keyInput) {
      keyInput.addEventListener('input', () => {
        if (keyInput.value.trim().startsWith('sk-') && apiDot) {
          apiDot.className = 'status-dot ok';
        }
      });
    }
    if (keySave) {
      keySave.addEventListener('click', () => {
        const key = (keyInput?.value || '').trim();
        if (!key || key.indexOf('•') >= 0) {
          toast('Yeni bir API Key yapıştırın.', 'warn');
          return;
        }
        APIManager.setApiKey(key);
        const saved = APIManager.getApiKey();
        if (saved) {
          keyInput.value = APIManager.maskApiKey(saved);
          if (apiDot) apiDot.className = 'status-dot ok';
          toast('API Key kaydedildi ve şifrelendi. 🔒', 'success');
        } else {
          toast('API Key geçersiz.', 'error');
        }
      });
    }
    if (keyShow) {
      keyShow.addEventListener('click', () => {
        if (keyInput.type === 'password') {
          keyInput.type = 'text';
          keyShow.textContent = '🙈';
        } else {
          keyInput.type = 'password';
          keyShow.textContent = '👁';
        }
      });
    }

    // Transkript et
    const transcribeBtn = document.getElementById('transcribeBtn');
    if (transcribeBtn) transcribeBtn.addEventListener('click', _onTranscribeClick);

    // Ayarlar çekmecesi
    const settingsBtn      = document.getElementById('settingsBtn');
    const settingsClose    = document.getElementById('settingsClose');
    const settingsBackdrop = document.getElementById('settingsBackdrop');
    const settingsDrawer   = document.getElementById('settingsDrawer');

    const openDrawer  = () => { settingsDrawer?.classList.add('open'); settingsBackdrop?.classList.add('open'); };
    const closeDrawer = () => { settingsDrawer?.classList.remove('open'); settingsBackdrop?.classList.remove('open'); };

    if (settingsBtn)      settingsBtn.addEventListener('click', openDrawer);
    if (settingsClose)    settingsClose.addEventListener('click', closeDrawer);
    if (settingsBackdrop) settingsBackdrop.addEventListener('click', closeDrawer);

    if (!APIManager.hasStoredKey()) setTimeout(openDrawer, 400);

    // Sessizlik tara
    const scanSilenceBtn = document.getElementById('scanSilenceBtn');
    if (scanSilenceBtn) scanSilenceBtn.addEventListener('click', _onScanSilences);

    // Tüm sessizlikleri sil
    const deleteAllSilenceBtn = document.getElementById('deleteAllSilenceBtn');
    if (deleteAllSilenceBtn) deleteAllSilenceBtn.addEventListener('click', _onAddAllSilencesToList);

    // Tekrar tara
    const scanRepeatBtn = document.getElementById('scanRepeatBtn');
    if (scanRepeatBtn) scanRepeatBtn.addEventListener('click', _onScanRepeats);

    // Filler kelimeler
    const markFillerBtn = document.getElementById('markFillerBtn');
    if (markFillerBtn) markFillerBtn.addEventListener('click', _onMarkFillers);

    // Toplu sil
    const applyDeleteBtn = document.getElementById('applyDeleteBtn');
    if (applyDeleteBtn) applyDeleteBtn.addEventListener('click', _onApplyDelete);

    // Altyazı oluştur
    const genSubBtn = document.getElementById('generateSubtitlesBtn');
    if (genSubBtn) genSubBtn.addEventListener('click', _onGenerateSubtitles);

    // Stil kontrolleri
    _initStyleControls();
    _renderFillerChips();

    TranscriptEditor.init('transcriptArea');
    updateStats();

    log('Rast Flow AI hazır. 🚀', 'success');
  }

  async function _onTranscribeClick() {
    const btn = document.getElementById('transcribeBtn');
    btn.disabled = true;
    _showLoading(true);

    const useInOutOnly = document.getElementById('inOutOnly')?.checked === true;
    const language     = document.getElementById('languageSelect')?.value || 'tr';

    log(useInOutOnly ? 'Mod: Sadece In/Out aralığı' : 'Mod: Tüm sekans', 'info');

    try {
      const words = await APIManager.transcribe((pct, msg) => {
        _setProgress(pct);
        log(msg, 'info');
        const lt = document.getElementById('loadingText');
        if (lt) lt.textContent = msg;
      }, { useInOutOnly, language });

      TranscriptStore.load(words);
      toast(`${words.length} kelime transkript edildi.`, 'success');
      log('Transkript tamamlandı: ' + words.length + ' kelime.', 'success');

      const transcriptTab = document.querySelector('.tab[data-panel="panelTranscript"]');
      if (transcriptTab) transcriptTab.click();

      // Otomatik sessizlik tarama
      _onScanSilences();

    } catch (e) {
      toast('Hata: ' + e.message, 'error');
      log('Hata: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      _showLoading(false);
    }
  }

  function _getSilenceThreshold() {
    const th2 = document.getElementById('silenceThreshold2');
    const th1 = document.getElementById('silenceThreshold');
    return parseFloat(th2?.value || th1?.value || 0.4);
  }

  function _onScanSilences() {
    const threshold = _getSilenceThreshold();
    const silences  = SilenceRemover.scanSilences(threshold);

    _silenceDeleteList = [...silences]; // yeni tarama → listeyi sıfırla

    TranscriptStore.notifyAll(); // renderer'ı güncelle (marker'lar yeniden çizilsin)

    const countEl = document.getElementById('silenceCount');
    if (countEl) countEl.textContent = silences.length + ' adet';

    const totalDur = silences.reduce((a, s) => a + s.duration, 0);
    const durEl    = document.getElementById('silenceTotalDur');
    if (durEl) durEl.textContent = totalDur.toFixed(1) + 's';

    toast(`${silences.length} sessizlik tespit edildi (toplam ${totalDur.toFixed(1)}s).`,
      silences.length > 0 ? 'warn' : 'info');
    log(silences.length + ' sessizlik bulundu (eşik: ' + threshold + 's, toplam: ' + totalDur.toFixed(1) + 's)', 'info');
  }

  function _onAddAllSilencesToList() {
    if (_silenceDeleteList.length === 0) {
      toast('Önce "Sessizlikleri Tara" butonuna basın.', 'warn');
      return;
    }
    toast(`${_silenceDeleteList.length} sessizlik silim listesine eklendi.`, 'info');
    log(_silenceDeleteList.length + ' sessizlik silim listesine alındı.', 'info');
  }

  function _onScanRepeats() {
    const method  = document.getElementById('repeatMethod')?.value || 'exact';
    const repeats = SilenceRemover.findRepeats(method);
    TranscriptStore.notifyAll();
    if (repeats.length) {
      toast(`${repeats.length} tekrar tespit edildi. Kırmızıyla işaretlendi.`, 'warn');
      log(repeats.length + ' tekrar bulundu (' + method + ' mod).', 'warn');
    } else {
      toast('Tekrar bulunamadı.', 'info');
    }
  }

  function _onMarkFillers() {
    const count = SilenceRemover.markFillers(_fillerList);
    TranscriptStore.notifyAll();
    toast(`${count} filler kelime işaretlendi (turuncu).`, count > 0 ? 'warn' : 'info');
  }

  async function _onApplyDelete() {
    const btn       = document.getElementById('applyDeleteBtn');
    const doRipple  = document.getElementById('rippleDeleteToggle')?.checked !== false;
    const allTracks = document.getElementById('allTracksToggle')?.checked !== false;

    btn.disabled = true;

    try {
      const wordRanges = TranscriptStore.getDeleteRanges();
      const allRanges  = [...wordRanges, ..._silenceDeleteList];

      if (allRanges.length === 0) {
        toast('Silinecek bir şey yok.', 'info');
        return;
      }

      _showLoading(true);
      log(`${allRanges.length} aralık Premiere'e gönderiliyor (ripple: ${doRipple})…`, 'info');

      const result = await SilenceRemover.applyRippleDelete(allRanges, doRipple);

      if (result.success) {
        toast(`${result.deletedCount} kesim uygulandı ✓`, 'success');
        log('Ripple delete tamamlandı: ' + result.deletedCount + ' kesim.', 'success');
        _silenceDeleteList = [];
        const countEl = document.getElementById('silenceCount');
        if (countEl) countEl.textContent = '0 adet';
      } else {
        toast('Kesim hatası: ' + result.error, 'error');
        log('Hata: ' + result.error, 'error');
      }

    } catch (e) {
      toast('Hata: ' + e.message, 'error');
      log('Hata: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      _showLoading(false);
    }
  }

  async function _onGenerateSubtitles() {
    const btn = document.getElementById('generateSubtitlesBtn');
    btn.disabled = true;
    _showLoading(true);

    try {
      const result = await SubtitleEngine.generateSubtitles();
      if (result.success) {
        const msg = result.importedToProject
          ? `SRT oluşturuldu ve Premiere projesine aktarıldı ✓\n📁 ${result.srtPath}`
          : `SRT dosyası oluşturuldu:\n📁 ${result.srtPath}\n\nDosyayı Premiere'e sürükleyip bırakın.`;
        toast('Altyazı SRT oluşturuldu! ✓', 'success');
        log(msg, 'success');

        // Yolu göster
        const srtPathEl = document.getElementById('srtFilePath');
        if (srtPathEl) {
          srtPathEl.textContent = result.srtPath || '—';
          srtPathEl.title = result.srtPath;
          document.getElementById('srtPathSection')?.style.setProperty('display', 'block');
        }
      } else {
        toast('Altyazı hatası: ' + result.error, 'error');
        log('Hata: ' + result.error, 'error');
      }
    } catch (e) {
      toast('Hata: ' + e.message, 'error');
      log('Hata: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      _showLoading(false);
    }
  }

  /* ── Stil Kontrolleri ── */
  function _initStyleControls() {
    const controls = {
      fontFamily    : 'fontFamilySelect',
      fontSize      : 'fontSizeInput',
      color         : 'textColorInput',
      strokeWidth   : 'strokeWidthInput',
      strokeColor   : 'strokeColorInput',
      highlightColor: 'highlightColorInput',
      positionY     : 'positionYInput'
    };

    Object.entries(controls).forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        const update = {};
        update[key] = el.type === 'number' || el.type === 'range'
          ? parseFloat(el.value) : el.value;
        SubtitleEngine.setStyle(update);
      });
    });

    document.querySelectorAll('.color-option').forEach(sw => {
      sw.addEventListener('click', () => {
        const target = sw.dataset.target;
        const color  = sw.dataset.color;
        const update = {};
        update[target] = color;
        SubtitleEngine.setStyle(update);
        const input = document.getElementById(target + 'Input');
        if (input) input.value = color;
        document.querySelectorAll('.color-option[data-target="' + target + '"]')
          .forEach(x => x.classList.remove('selected'));
        sw.classList.add('selected');
      });
    });
  }

  function _renderFillerChips() {
    const container = document.getElementById('fillerChips');
    if (!container) return;
    container.innerHTML = '';

    _fillerList.forEach(word => {
      const chip = document.createElement('span');
      chip.className = 'chip active';
      chip.textContent = word;
      chip.addEventListener('click', () => {
        _fillerList = _fillerList.filter(w => w !== word);
        _renderFillerChips();
      });
      container.appendChild(chip);
    });

    const addChip = document.createElement('span');
    addChip.className = 'chip add-chip';
    addChip.textContent = '+ Ekle';
    addChip.addEventListener('click', () => {
      const w = prompt('Eklenecek filler kelime:');
      if (w && w.trim()) {
        _fillerList.push(w.trim().toLowerCase());
        _renderFillerChips();
      }
    });
    container.appendChild(addChip);
  }

  function addSilenceToDeleteList(range) {
    // Çakışma kontrolü
    const overlap = _silenceDeleteList.some(
      r => r.start < range.end && r.end > range.start
    );
    if (!overlap) {
      _silenceDeleteList.push(range);
    }
    toast(`Sessizlik (${range.start.toFixed(2)}s – ${range.end.toFixed(2)}s) eklendi.`, 'info');
  }

  function updateStats() {
    const words    = TranscriptStore.getWords();
    const deleted  = TranscriptStore.getWords(true).filter(w => w.deleted).length;
    const segs     = TranscriptStore.getSegmentedWords().length;
    const duration = words.length > 0 ? words[words.length - 1].end : 0;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('statWordCount',    words.length);
    set('statDeletedCount', deleted);
    set('statSegCount',     segs);
    set('statDuration',     _fmt(duration));
  }

  /* ── Yardımcılar ── */
  function _showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = show ? 'flex' : 'none';
  }

  function _setProgress(pct) {
    const fill = document.querySelector('.progress-fill');
    if (fill) {
      fill.classList.remove('indeterminate');
      fill.style.width = pct + '%';
      if (pct >= 100) setTimeout(() => fill.style.width = '0%', 800);
    }
  }

  function log(msg, type = 'info') {
    const panel = document.getElementById('logPanel');
    if (!panel) return;
    const line = document.createElement('div');
    line.className = 'log-' + type;
    line.textContent = '[' + _timeNow() + '] ' + msg;
    panel.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
    while (panel.children.length > 50) panel.removeChild(panel.firstChild);
  }

  function toast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function _timeNow() { return new Date().toTimeString().slice(0, 8); }

  function _fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  return { init, updateStats, addSilenceToDeleteList, log, toast };
})();

/* ── DOM Hazır ── */
document.addEventListener('DOMContentLoaded', () => {
  UIController.init();
});
