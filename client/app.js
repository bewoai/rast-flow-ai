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
  let _lastWavPath = '';
  let _lastWavOffset = 0;

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

    const segRaw = await _evalScript('getTimelineAudioSegments(' + (useInOutOnly ? 'true' : 'false') + ')');
    let info;
    try {
      info = JSON.parse(segRaw);
    } catch (e) {
      throw new Error('Premiere Pro\'dan geçerli yanıt alınamadı. (CEP bağlantısını kontrol edin.)');
    }
    if (!info || !info.success) {
      throw new Error('Kaynak ses alınamadı: ' + (info ? info.error : 'bilinmeyen hata'));
    }

    const baseOffset    = (typeof info.rangeStart === 'number') ? info.rangeStart : 0;
    const totalDuration = info.rangeEnd - info.rangeStart;

    onProgress && onProgress(15,
      `Ses çıkarılıyor (${info.segments.length} klip · ${info.trackName})…`);
    const filePath = await _buildTimelineWav(info.segments, info.rangeStart, info.rangeEnd, (p) => {
      onProgress && onProgress(15 + Math.round(p * 0.15), `Timeline sesi birleştiriliyor… (${info.segments.length} klip)`);
    });

    // Keep active WAV file path for silence detection
    _lastWavPath = filePath;
    _lastWavOffset = baseOffset;

    const rangeMsg = info.mode === 'inout'
      ? `In/Out aralığı (${baseOffset.toFixed(1)}s, ${totalDuration.toFixed(1)}s · ${info.segments.length} klip) Whisper'a gönderiliyor…`
      : 'Tüm sekans Whisper\'a gönderiliyor…';
    onProgress && onProgress(30, rangeMsg);

    let words;
    if (totalDuration > 900) {
      onProgress && onProgress(30, `Uzun ses (${(totalDuration / 60).toFixed(1)} dk) — 10 dakikalık parçalara bölünüyor…`);
      words = await _transcribeInChunks(filePath, key, language, totalDuration, (p, msg) => {
        onProgress && onProgress(30 + Math.round(p * 60), msg);
      });
    } else {
      words = await _sendToWhisper(filePath, key, language, (p) => {
        onProgress && onProgress(30 + Math.round(p * 60), 'Transkript alınıyor…');
      });
    }

    if (baseOffset > 0) {
      words.forEach(w => {
        w.start = parseFloat((w.start + baseOffset).toFixed(3));
        w.end   = parseFloat((w.end   + baseOffset).toFixed(3));
      });
    }

    onProgress && onProgress(100, 'Tamamlandı.');
    return words;
  }

  async function _transcribeInChunks(filePath, apiKey, language, totalDuration, onProgress) {
    if (typeof require !== 'function') throw new Error('Node.js entegrasyonu yok.');
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');
    const cp   = require('child_process');
    const ff   = _findFfmpeg();
    const CHUNK = 600; // 10 dakika (saniye)
    const allWords = [];
    const numChunks = Math.ceil(totalDuration / CHUNK);

    for (let i = 0; i < numChunks; i++) {
      const offset  = i * CHUNK;
      const dur     = Math.min(CHUNK, totalDuration - offset);
      const chunkWav = path.join(os.tmpdir(), `rastflow_chunk_${Date.now()}_${i}.wav`);

      // Input-seeking ile parça çıkar (hızlı)
      await new Promise((resolve, reject) => {
        const args = ['-ss', String(offset), '-i', filePath,
          '-t', String(dur), '-vn', '-ac', '1', '-ar', '16000',
          '-c:a', 'pcm_s16le', '-y', chunkWav];
        cp.execFile(ff, args, { maxBuffer: 1 << 28 }, err => err ? reject(new Error(err.message)) : resolve());
      });

      onProgress && onProgress(i / numChunks, `Parça ${i + 1}/${numChunks} Whisper'a gönderiliyor…`);

      const chunkWords = await _sendToWhisper(chunkWav, apiKey, language, null);
      chunkWords.forEach(w => {
        allWords.push({
          ...w,
          start: parseFloat((w.start + offset).toFixed(3)),
          end  : parseFloat((w.end   + offset).toFixed(3))
        });
      });

      try { fs.unlinkSync(chunkWav); } catch (e) {}
    }

    return allWords;
  }

  /**
   * Timeline aralığındaki klipleri tek bir WAV'a birleştirir.
   * Klipler arası boşluklar sessizlikle korunur → kelime zaman damgaları
   * timeline ile birebir hizalı kalır. FFmpeg gerektirir (tek klipte WebAudio fallback).
   */
  async function _buildTimelineWav(segments, rangeStart, rangeEnd, onProgress) {
    if (typeof require !== 'function') throw new Error('Node.js entegrasyonu yok.');
    try {
      return await _concatWithFfmpeg(segments, rangeStart, rangeEnd, onProgress);
    } catch (ffErr) {
      // FFmpeg yok/başarısız → WebAudio ile çoklu klip birleştirme (bağımsız, dosyasız)
      return await _buildTimelineWavWebAudio(segments, rangeStart, rangeEnd, onProgress);
    }
  }

  /** WebAudio ile çoklu klip birleştirici — FFmpeg olmadan çalışır. */
  async function _buildTimelineWavWebAudio(segments, rangeStart, rangeEnd, onProgress) {
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');
    const AC   = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Ses çözücü kullanılamıyor (AudioContext yok) ve FFmpeg bulunamadı.');

    const targetSR     = 16000;
    const totalSamples = Math.max(1, Math.ceil((rangeEnd - rangeStart) * targetSR));
    const out          = new Float32Array(totalSamples); // varsayılan sessizlik

    const cache = {};
    async function getDecoded(p) {
      if (cache[p]) return cache[p];
      const buf      = fs.readFileSync(p);
      const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const ctx      = new AC();
      try {
        const d = await ctx.decodeAudioData(arrayBuf);
        cache[p] = d;
        return d;
      } finally {
        try { ctx.close(); } catch (e) {}
      }
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      let decoded;
      try {
        decoded = await getDecoded(seg.path);
      } catch (e) {
        throw new Error('Medya çözülemedi (' + seg.path + '): ' + e.message);
      }
      const segData  = await _resampleSegment(decoded, seg.srcStart, seg.duration, targetSR);
      const outStart = Math.floor((seg.tlStart - rangeStart) * targetSR);
      for (let j = 0; j < segData.length; j++) {
        const oi = outStart + j;
        if (oi >= 0 && oi < totalSamples) out[oi] = segData[j];
      }
      onProgress && onProgress(Math.round(((i + 1) / segments.length) * 100));
    }

    const outPath = path.join(os.tmpdir(), 'rastflow_audio_' + Date.now() + '.wav');
    fs.writeFileSync(outPath, Buffer.from(_encodeWav(out, targetSR)));
    return outPath;
  }

  /** Decoded AudioBuffer'dan [srcStart, srcStart+duration] aralığını 16k mono'ya indirir. */
  async function _resampleSegment(decoded, srcStart, duration, targetSR) {
    const inSR        = decoded.sampleRate;
    const startSample = Math.max(0, Math.floor(srcStart * inSR));
    const lenSample   = Math.min(decoded.length - startSample, Math.floor(duration * inSR));
    if (lenSample <= 0) return new Float32Array(0);

    const chs  = decoded.numberOfChannels;
    const mono = new Float32Array(lenSample);
    for (let ch = 0; ch < chs; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < lenSample; i++) mono[i] += (data[startSample + i] || 0) / chs;
    }

    const outLen  = Math.max(1, Math.ceil(duration * targetSR));
    const offline = new OfflineAudioContext(1, outLen, targetSR);
    const tmpBuf  = offline.createBuffer(1, lenSample, inSR);
    tmpBuf.copyToChannel(mono, 0);
    const node = offline.createBufferSource();
    node.buffer = tmpBuf;
    node.connect(offline.destination);
    node.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  function _concatWithFfmpeg(segments, rangeStart, rangeEnd, onProgress) {
    return new Promise(async (resolve, reject) => {
      try {
        const fs   = require('fs');
        const path = require('path');
        const os   = require('os');
        const cp   = require('child_process');
        const SR   = 16000;
        const ff   = _findFfmpeg();
        const tmp  = os.tmpdir();
        const stamp = Date.now();
        const pieces  = [];
        const cleanup = [];

        const run = (args, label) => new Promise((res, rej) => {
          cp.execFile(ff, args, { maxBuffer: 1 << 28 }, (err) => err ? rej(new Error(label + ': ' + err.message)) : res());
        });

        const genSilence = (dur, idx) => {
          const p = path.join(tmp, `rastflow_sil_${stamp}_${idx}.wav`);
          return run(['-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=${SR}`,
            '-t', dur.toFixed(3), '-c:a', 'pcm_s16le', '-y', p], 'silence').then(() => p);
        };
        const extractSeg = (seg, idx) => {
          const p = path.join(tmp, `rastflow_seg_${stamp}_${idx}.wav`);
          // Input-seeking (-ss, -i'den ÖNCE) → uzun videolarda 10x hız
          return run(['-ss', String(seg.srcStart), '-i', seg.path,
            '-t', String(seg.duration), '-vn', '-ac', '1', '-ar', String(SR),
            '-c:a', 'pcm_s16le', '-y', p], 'segment').then(() => p);
        };

        let prevEnd = rangeStart;
        let silIdx  = 0;
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          const gap = seg.tlStart - prevEnd;
          if (gap > 0.02) pieces.push(await genSilence(gap, silIdx++));
          pieces.push(await extractSeg(seg, i));
          prevEnd = seg.tlStart + seg.duration;
          onProgress && onProgress(Math.round(((i + 1) / segments.length) * 100));
        }
        const tailGap = rangeEnd - prevEnd;
        if (tailGap > 0.02) pieces.push(await genSilence(tailGap, silIdx++));

        cleanup.push(...pieces);

        // concat demuxer listesi (tüm parçalar aynı format → -c copy)
        const listPath = path.join(tmp, `rastflow_concat_${stamp}.txt`);
        const listBody = pieces.map(p => "file '" + p.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n');
        fs.writeFileSync(listPath, listBody, 'utf8');
        cleanup.push(listPath);

        const outWav = path.join(tmp, `rastflow_audio_${stamp}.wav`);
        await run(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', outWav], 'concat');

        cleanup.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });

        if (!fs.existsSync(outWav) || fs.statSync(outWav).size === 0) {
          reject(new Error('Birleştirilmiş ses üretilemedi (boş dosya).'));
          return;
        }
        resolve(outWav);
      } catch (e) {
        reject(e);
      }
    });
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
            '-ss', String(srcStart),   // input-seeking: -i'den ÖNCE (10x hızlı)
            '-i', srcPath,
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

  function getLastWavPath() { return _lastWavPath; }
  function getLastWavOffset() { return _lastWavOffset; }
  function cleanupLastWav() {
    if (_lastWavPath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(_lastWavPath)) fs.unlinkSync(_lastWavPath);
      } catch (e) {}
      _lastWavPath = '';
    }
  }

  return { setApiKey, getApiKey, hasStoredKey, maskApiKey, transcribe, getLastWavPath, getLastWavOffset, cleanupLastWav, findFfmpeg: _findFfmpeg };
})();


/* ══════════════════════════════════════════════════════════════════
   B. TranscriptStore  –  Kelime verisi yönetimi
   ══════════════════════════════════════════════════════════════════ */
const TranscriptStore = (() => {
  let _words     = [];
  let _segments  = [];
  let _listeners = [];
  let _undoStack = [];

  function load(wordsArray) {
    _words    = wordsArray.map(w => ({ ...w, deleted: false, filler: false, repeat: false }));
    _segments = [];
    _undoStack = [];
    _notify();
  }

  // Tam anlık görüntü — silme/ekleme/taşıma dahil her tür düzenlemeyi geri alır.
  function pushUndo() {
    if (_undoStack.length >= 25) _undoStack.shift();
    _undoStack.push({
      words   : _words.map(w => ({ ...w })),
      segments: _segments.map(s => ({ ...s }))
    });
  }

  function undo() {
    const snap = _undoStack.pop();
    if (!snap) return false;
    _words    = snap.words.map(w => ({ ...w }));
    _segments = snap.segments.map(s => ({ ...s }));
    _notify();
    return true;
  }

  function getWords(includeDeleted = false) {
    return includeDeleted ? [..._words] : _words.filter(w => !w.deleted);
  }

  function getSegments() { return [..._segments]; }

  function updateWord(id, newText) {
    const w = _words.find(x => x.id === id);
    if (w) { w.word = newText; _notify(); }
  }

  const _PUNCT = `.,!?;:"'()[]{}…«»–—-`;
  /** Kelimeyi öncü noktalama / çekirdek / sondaki noktalama olarak ayır. */
  function splitWord(word) {
    let s = 0, e = word.length;
    while (s < e && _PUNCT.indexOf(word[s])     >= 0) s++;
    while (e > s && _PUNCT.indexOf(word[e - 1]) >= 0) e--;
    return { lead: word.slice(0, s), core: word.slice(s, e), trail: word.slice(e) };
  }

  /** Eşleşen TÜM kelimeleri tek hamlede değiştir (noktalamayı korur). Eşleşme sayısını döndürür. */
  function replaceAll(findText, replaceText, caseSensitive) {
    const find = (findText || '').trim();
    if (!find) return 0;
    const norm   = s => caseSensitive ? s : s.toLocaleLowerCase('tr');
    const target = norm(find);
    let count = 0, snapped = false;
    _words.forEach(w => {
      const { lead, core, trail } = splitWord(w.word);
      if (core && norm(core) === target) {
        if (!snapped) { pushUndo(); snapped = true; }
        w.word = lead + replaceText + trail;
        count++;
      }
    });
    if (count) _notify();
    return count;
  }

  /** AI/toplu metin güncellemesi: [{id, word}] listesini uygula (tek undo, tek render). */
  function applyWordTexts(items) {
    if (!items || !items.length) return 0;
    pushUndo();
    let count = 0;
    items.forEach(it => {
      const w = _words.find(x => String(x.id) === String(it.id));
      if (w && typeof it.word === 'string' && it.word.trim()) { w.word = it.word.trim(); count++; }
    });
    if (count) _notify();
    return count;
  }

  function deleteWord(id) {
    const w = _words.find(x => x.id === id);
    if (w && !w.deleted) { pushUndo([id]); w.deleted = true; _notify(); }
  }

  function restoreWord(id) {
    const w = _words.find(x => x.id === id);
    if (w) { w.deleted = false; w.repeat = false; w.filler = false; w.aiDeleted = false; w.applied = false; w.aiReason = ''; _notify(); }
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
    pushUndo();
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

  /** Yeni kelimeyi belirli bir kelimenin ÖNÜNE ekle (kart başına ekleme için). */
  function insertWordBefore(beforeId, newText) {
    const idx = _words.findIndex(x => x.id === beforeId);
    if (idx === -1) return;
    if (idx === 0) {
      pushUndo();
      const first = _words[0];
      const newWord = {
        id: _uid(), word: newText,
        start: parseFloat(Math.max(0, first.start - 0.3).toFixed(3)),
        end  : parseFloat(Math.max(0.05, first.start).toFixed(3)),
        deleted: false, filler: false, repeat: false, virtual: true
      };
      _words.unshift(newWord);
      _notify();
      return newWord;
    }
    return insertWordAfter(_words[idx - 1].id, newText);
  }

  /** Kelimeyi transkript metninden tamamen çıkar (Whisper hatasını düzeltmek için). */
  function removeWord(id) {
    const idx = _words.findIndex(x => x.id === id);
    if (idx === -1) return;
    pushUndo();
    _words.splice(idx, 1);
    _segments = _segments.filter(s => s.afterWordId !== id); // bu kelimedeki segment break'i de temizle
    _notify();
  }

  /** Kelimeyi refId'nin önüne (after=false) veya arkasına (after=true) taşı; zamanı yeniden ata. */
  function moveWord(id, refId, after) {
    const fromIdx = _words.findIndex(x => x.id === id);
    if (fromIdx === -1 || id === refId) return;
    pushUndo();
    const moved = _words.splice(fromIdx, 1)[0];
    let refIdx = _words.findIndex(x => x.id === refId);
    let toIdx;
    if (refIdx === -1) toIdx = _words.length;
    else toIdx = after ? refIdx + 1 : refIdx;
    _words.splice(toIdx, 0, moved);
    _reassignTiming(toIdx);
    _notify();
  }

  /** Taşınan kelimenin zaman damgasını komşularına göre yeniden hesapla (monoton sıra korunur). */
  function _reassignTiming(idx) {
    const w    = _words[idx];
    const prev = _words[idx - 1];
    const next = _words[idx + 1];
    let start, end;
    if (prev && next)  { start = prev.end;                    end = Math.max(prev.end + 0.05, next.start); }
    else if (prev)     { start = prev.end;                    end = prev.end + 0.3; }
    else if (next)     { start = Math.max(0, next.start - 0.3); end = next.start; }
    else               { start = 0;                           end = 0.3; }
    if (end <= start) end = start + 0.2;
    w.start = parseFloat(start.toFixed(3));
    w.end   = parseFloat(end.toFixed(3));
    w.moved = true;
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

  /** Tüm segment break'lerini tek seferde ayarla (otomatik bölme için — tek render). */
  function setSegmentBreaks(afterWordIds) {
    _segments = (afterWordIds || []).map(id => ({ afterWordId: id, id: _uid() }));
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

  /** Bir kelime BEKLEYEN kesim mi? (işaretli ama henüz Premiere'e uygulanmamış) */
  function _isCut(w) { return (w.deleted || w.filler || w.repeat || w.aiDeleted) && !w.applied; }

  /** Apply sonrası: bekleyen tüm kesimleri "uygulandı" işaretle (çubuktan düşer, görünümden kalkar) */
  function markAppliedCuts() {
    _words.forEach(w => {
      if (_isCut(w)) {
        w.deleted = true; w.applied = true;
        w.filler = false; w.repeat = false; w.aiDeleted = false;
      }
    });
    _notify();
  }

  /** Silinecek aralıkları hesapla — komşu sessizliği de dahil eder */
  function getDeleteRanges() {
    // Timeline'da KALAN kelimeler (hiçbir işareti olmayanlar)
    const active = _words.filter(w => !w.deleted && !w.filler && !w.repeat && !w.aiDeleted);
    const toCut  = _words.filter(_isCut);   // bekleyen (uygulanmamış) kesimler
    const ranges = [];

    for (const w of toCut) {
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
    markFiller, markRepeat, insertWordAfter, insertWordBefore, removeWord, moveWord,
    replaceAll, applyWordTexts, splitWord,
    addSegmentBreak, removeSegmentBreak, setSegmentBreaks,
    getSegmentedWords, getDeleteRanges,
    markAppliedCuts,
    pushUndo, undo, onChange, notifyAll
  };
})();


/* ══════════════════════════════════════════════════════════════════
   C. TranscriptEditor  –  Etkileşimli DOM editörü
   ══════════════════════════════════════════════════════════════════ */
const TranscriptEditor = (() => {
  let _container    = null;
  let _contextMenu  = null;
  let _currentTime  = 0;
  let _dragId       = null;

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

    if (!words || words.length === 0) {
      _container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎙️</div>
          <div class="empty-state-title">Henüz transkript yok</div>
          <div class="empty-state-desc">Yukarıdan transkript oluştur butonuna basın.</div>
        </div>`;
      return;
    }

    const silences = SilenceRemover.getDetectedSilences() || [];
    const groups   = TranscriptStore.getSegmentedWords();
    const fragment = document.createDocumentFragment();

    groups.forEach((group, groupIdx) => {
      // ── Kart ──────────────────────────────────────────────
      const card = document.createElement('div');
      card.className = 'subtitle-card';
      card.dataset.groupIdx = groupIdx;

      // Başlık: zaman + karakter sayacı
      const header = document.createElement('div');
      header.className = 'subtitle-card-header';

      const timeEl = document.createElement('span');
      timeEl.className = 'subtitle-card-time';
      timeEl.textContent = _fmt(group[0].start);

      const charCount = group.map(w => w.word).join(' ').length;
      const charEl = document.createElement('span');
      charEl.className = 'subtitle-card-chars' + (charCount > 42 ? ' over-limit' : '');
      charEl.textContent = charCount + ' kar';

      header.appendChild(timeEl);
      header.appendChild(charEl);
      card.appendChild(header);

      // Gövde: kelime span'ları + sessizlik bantları
      const body = document.createElement('div');
      body.className = 'subtitle-card-body';

      group.forEach((w, idx) => {
        if (idx > 0) {
          const prevW = group[idx - 1];
          const midSilences = silences.filter(
            s => s.start >= prevW.end - 0.05 && s.end <= w.start + 0.05
          );
          midSilences.forEach(s => {
            const marker = document.createElement('span');
            marker.className = 'silence-band';
            if (UIController.isSilenceQueued(s)) marker.classList.add('queued');
            marker.dataset.start = s.start;
            marker.dataset.end   = s.end;
            marker.title = `${s.duration.toFixed(2)}s sessizlik — Tıkla ekle/kaldır`;
            const bandW = Math.min(80, Math.max(12, s.duration * 20));
            marker.style.width = bandW + 'px';
            if (bandW > 35) marker.textContent = s.duration.toFixed(1) + 's';
            marker.addEventListener('click', () => UIController.toggleSilenceQueue(s, marker));
            body.appendChild(marker);
          });
        }

        const wrap = document.createElement('span');
        wrap.className = 'word-wrap';

        const span = document.createElement('span');
        span.className     = 'word';
        span.dataset.id    = w.id;
        span.dataset.start = w.start;
        span.dataset.end   = w.end;
        span.textContent   = w.word;
        span.draggable     = true;

        if (w.filler)  span.classList.add('filler');
        if (w.repeat)  span.classList.add('repeat');
        if (w.aiDeleted) {
          span.classList.add('ai-deleted');
          if (w.aiReason) span.dataset.aiReason = w.aiReason;
        }
        if (w.virtual || w.moved) span.title = 'Elle düzenlendi';

        span.addEventListener('click',       _onWordClick);
        span.addEventListener('dblclick',    _onWordDblClick);
        span.addEventListener('contextmenu', _onWordContextMenu);
        span.addEventListener('dragstart',   _onDragStart);
        span.addEventListener('dragover',    _onDragOver);
        span.addEventListener('dragleave',   _onDragLeave);
        span.addEventListener('drop',        _onDrop);
        span.addEventListener('dragend',     _onDragEnd);

        // × Transkriptten sil
        const xBtn = document.createElement('span');
        xBtn.className   = 'word-x';
        xBtn.textContent = '×';
        xBtn.title       = 'Transkriptten sil';
        xBtn.addEventListener('click', (ev) => { ev.stopPropagation(); TranscriptStore.removeWord(w.id); });

        wrap.appendChild(span);
        wrap.appendChild(xBtn);
        body.appendChild(wrap);
        body.appendChild(document.createTextNode(' ')); // satır kaydırma için boşluk
      });

      // ＋ Bu satıra kelime ekle
      const addBtn = document.createElement('span');
      addBtn.className   = 'word-add';
      addBtn.textContent = '＋';
      addBtn.title       = 'Bu satıra kelime ekle';
      const lastW = group[group.length - 1];
      addBtn.addEventListener('click', () => {
        const t = prompt('Eklenecek kelime:');
        if (t && t.trim()) TranscriptStore.insertWordAfter(lastW.id, t.trim());
      });
      body.appendChild(addBtn);

      card.appendChild(body);
      fragment.appendChild(card);

      // Kartlar arası birleştirme çizgisi
      if (groupIdx < groups.length - 1) {
        const lastWord = group[group.length - 1];
        const mergeLine = document.createElement('div');
        mergeLine.className = 'card-merge-line';
        const mergeBtn = document.createElement('button');
        mergeBtn.className = 'card-merge-btn';
        mergeBtn.textContent = 'Birleştir';
        mergeBtn.addEventListener('click', () => TranscriptStore.removeSegmentBreak(lastWord.id));
        mergeLine.appendChild(mergeBtn);
        fragment.appendChild(mergeLine);
      }
    });

    _container.innerHTML = '';
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

  /* ── Sürükle-bırak ile kelime taşıma ── */
  function _onDragStart(e) {
    _dragId = e.currentTarget.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', _dragId); } catch (x) {}
    e.currentTarget.classList.add('dragging');
  }
  function _onDragOver(e) {
    if (!_dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const span = e.currentTarget;
    if (span.dataset.id === _dragId) return;
    const rect  = span.getBoundingClientRect();
    const after = (e.clientX - rect.left) > rect.width / 2;
    span.classList.toggle('drop-after', after);
    span.classList.toggle('drop-before', !after);
  }
  function _onDragLeave(e) {
    e.currentTarget.classList.remove('drop-before', 'drop-after');
  }
  function _onDrop(e) {
    e.preventDefault();
    const span  = e.currentTarget;
    const refId = span.dataset.id;
    const after = span.classList.contains('drop-after');
    span.classList.remove('drop-before', 'drop-after');
    if (_dragId && refId && _dragId !== refId) {
      TranscriptStore.moveWord(_dragId, refId, after);
    }
    _dragId = null;
  }
  function _onDragEnd() {
    _dragId = null;
    if (_container) {
      _container.querySelectorAll('.dragging, .drop-before, .drop-after')
        .forEach(el => el.classList.remove('dragging', 'drop-before', 'drop-after'));
    }
  }

  function _onWordDblClick(e) {
    const span = e.currentTarget;
    const id   = span.dataset.id;
    const old  = span.textContent;

    span.draggable = false; // düzenleme sırasında sürüklemeyi kapat
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
      <div class="menu-item" data-action="replace-all">
        <span class="icon">🔁</span> Tüm "${word}" → değiştir…
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
      <div class="menu-item danger" data-action="remove">
        <span class="icon">🗑</span> Transkriptten sil
      </div>
      <div class="menu-item" data-action="mark-filler">
        <span class="icon">⚠</span> Filler işaretle
      </div>
      <div class="menu-item" data-action="cut">
        <span class="icon">✂</span> Videodan kes (kesim listesine)
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
      case 'replace-all': {
        const core = TranscriptStore.splitWord(word).core || word;
        const rep  = prompt(`Tüm "${core}" kelimelerini neyle değiştirelim?`, core);
        if (rep !== null && rep.trim()) {
          const n = TranscriptStore.replaceAll(core, rep.trim(), false);
          UIController.toast(`${n} "${core}" → "${rep.trim()}" olarak değiştirildi.`, n ? 'success' : 'info');
        }
        break;
      }
      case 'insert-before': {
        const text = prompt('Önüne eklenecek kelime:');
        if (text && text.trim()) TranscriptStore.insertWordBefore(id, text.trim());
        break;
      }
      case 'insert-after': {
        const text = prompt('Sonrasına eklenecek kelime:');
        if (text && text.trim()) TranscriptStore.insertWordAfter(id, text.trim());
        break;
      }
      case 'segment-break':
        TranscriptStore.addSegmentBreak(id);
        break;
      case 'mark-filler':
        TranscriptStore.markFiller(id);
        break;
      case 'remove':
        TranscriptStore.removeWord(id);
        break;
      case 'cut':
        TranscriptStore.deleteWord(id);
        break;
    }
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
    if (!_container) return;

    let activeCard = null;

    _container.querySelectorAll('.word').forEach(span => {
      const s = parseFloat(span.dataset.start);
      const e = parseFloat(span.dataset.end);
      const isPlaying = _currentTime >= s && _currentTime < e;
      span.classList.toggle('playing', isPlaying);
      if (isPlaying) activeCard = span.closest('.subtitle-card');
    });

    _container.querySelectorAll('.subtitle-card').forEach(c => c.classList.remove('active-card'));

    if (activeCard) {
      activeCard.classList.add('active-card');
      activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
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
    const el = document.getElementById('silenceMinDuration') ||
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
  let _detectedSilences = [];

  function getDetectedSilences() { return _detectedSilences; }

  function setDetectedSilences(arr) { _detectedSilences = arr; }

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

  async function scanSilencesFfmpeg(dbThreshold, minDuration) {
    const wavPath = APIManager.getLastWavPath();
    if (!wavPath) {
      throw new Error('Aktif ses dosyası bulunamadı. Lütfen önce transkript oluşturun.');
    }
    if (typeof require !== 'function') {
      throw new Error('Node.js entegrasyonu yok.');
    }
    const fs = require('fs');
    const cp = require('child_process');

    if (!fs.existsSync(wavPath)) {
      throw new Error('WAV ses dosyası bulunamadı. Lütfen yeniden transkript oluşturun.');
    }

    const ff = APIManager.findFfmpeg();
    if (!ff) {
      throw new Error('FFmpeg bulunamadı.');
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-i', wavPath,
        '-af', `silencedetect=noise=${dbThreshold}dB:d=${minDuration}`,
        '-f', 'null',
        '-'
      ];
      cp.execFile(ff, args, { maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
        const output = stderr || '';
        const silences = [];
        const lines = output.split('\n');
        
        let currentStart = null;
        const startRegex = /silence_start:\s*([0-9.]+)/i;
        const endRegex   = /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/i;
        const offset = APIManager.getLastWavOffset();

        for (const line of lines) {
          const startMatch = line.match(startRegex);
          if (startMatch) {
            currentStart = parseFloat(startMatch[1]) + offset;
          }
          const endMatch = line.match(endRegex);
          if (endMatch && currentStart !== null) {
            const end = parseFloat(endMatch[1]) + offset;
            const dur = parseFloat(endMatch[2]);
            silences.push({
              start: parseFloat(currentStart.toFixed(3)),
              end: parseFloat(end.toFixed(3)),
              duration: parseFloat(dur.toFixed(3))
            });
            currentStart = null;
          }
        }
        resolve(silences);
      });
    });
  }

  function _norm(word) {
    return (word || '').toLowerCase().replace(/[^\wğüşıöçĞÜŞİÖÇ]/g, '').trim();
  }

  /**
   * Tekrarları tespit et.
   * @param {string} method 'sliding' | 'exact' | 'fuzzy'
   * @returns {Array} repeatGroups [{phrase, count, startTime, wordIds}]
   */
  function findRepeats(method) {
    const words = TranscriptStore.getWords();
    words.forEach(w => TranscriptStore.markRepeat(w.id, false));

    if (method === 'exact' || method === 'fuzzy') {
      const repeats = [];
      for (let i = 0; i < words.length - 1; i++) {
        const a = _norm(words[i].word);
        const b = _norm(words[i + 1].word);
        const isRepeat = method === 'fuzzy'
          ? (a.length > 1 && b.length > 1 && _levenshtein(a, b) <= 2)
          : (a === b && a.length > 1);
        if (isRepeat) {
          TranscriptStore.markRepeat(words[i].id, true);
          repeats.push({ phrase: words[i].word, count: 2, startTime: words[i].start, wordIds: [words[i].id] });
        }
      }
      return repeats;
    }

    // sliding kayan-pencere algoritması
    const n          = words.length;
    const normalized = words.map(w => _norm(w.word));
    const repeatGroups = [];
    let i = 0;

    // Toplu silme için tek undo snapshot
    TranscriptStore.pushUndo(words.map(w => w.id));

    while (i < n) {
      let bestScore = -1, bestU = 0, bestL = 0;

      for (let u = 1; u <= Math.min(10, Math.floor((n - i) / 2)); u++) {
        let l = 1, j = i + u;
        while (j + u <= n) {
          let ok = true;
          for (let k = 0; k < u; k++) {
            if (normalized[i + k] !== normalized[j + k]) { ok = false; break; }
          }
          if (ok) { l++; j += u; } else break;
        }
        const score = u * (l - 1) - 2;
        if (score >= 0 && l > 1 && score > bestScore) {
          bestScore = score; bestU = u; bestL = l;
        }
      }

      if (bestScore >= 0) {
        const phrase = words.slice(i, i + bestU).map(w => w.word).join(' ');
        const group  = { phrase, count: bestL, startTime: words[i].start, wordIds: [] };

        // Son kopya hariç önceki tüm kopyaları sil + repeat işaretle
        for (let copy = 0; copy < bestL - 1; copy++) {
          for (let k = 0; k < bestU; k++) {
            const w = words[i + copy * bestU + k];
            w.deleted = true;
            w.repeat  = true;
            group.wordIds.push(w.id);
          }
        }
        // Son (doğru) kopyanın kelimelerini de repeat olarak işaretle ama silme
        for (let k = 0; k < bestU; k++) {
          const w = words[i + (bestL - 1) * bestU + k];
          TranscriptStore.markRepeat(w.id, true);
        }

        repeatGroups.push(group);
        i += bestU * bestL;
      } else {
        i++;
      }
    }

    return repeatGroups;
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

  return { scanSilences, scanSilencesFfmpeg, getDetectedSilences, setDetectedSilences, findRepeats, markFillers, applyRippleDelete, DEFAULT_FILLER };
})();


/* ══════════════════════════════════════════════════════════════════
   E-AI. AIEditorEngine  –  Yapay Zeka Transkript Temizleyici
   ══════════════════════════════════════════════════════════════════ */
const AIEditorEngine = (() => {
  const _STORAGE_KEY = 'rfai_ai_editor';
  let _reasons = [];

  function _loadSettings() {
    try { return JSON.parse(localStorage.getItem(_STORAGE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function _saveSettings(obj) {
    try { localStorage.setItem(_STORAGE_KEY, JSON.stringify(obj)); } catch (e) {}
  }

  function initUI() {
    const saved = _loadSettings();
    const keyEl   = document.getElementById('aiApiKey');
    const modelEl = document.getElementById('aiModelSelect');
    if (keyEl   && saved.apiKey) keyEl.value   = saved.apiKey;
    if (modelEl && saved.model)  modelEl.value = saved.model;

    const toggle = document.getElementById('aiKeyToggle');
    if (toggle && keyEl) {
      toggle.addEventListener('click', () => {
        keyEl.type = keyEl.type === 'password' ? 'text' : 'password';
        toggle.textContent = keyEl.type === 'password' ? '👁' : '🙈';
      });
    }
    if (keyEl)   keyEl.addEventListener('change',   () => _saveSettings({ ..._loadSettings(), apiKey: keyEl.value.trim() }));
    if (modelEl) modelEl.addEventListener('change', () => _saveSettings({ ..._loadSettings(), model: modelEl.value }));
  }

  const SYSTEM_PROMPT = `Sen titiz ve TUTUCU bir video transkript editörüsün. Amacın konuşmayı doğal ve akıcı tutmak; ASLA cümlenin anlamını veya gramerini bozmamak.

SADECE şunları sil:
- Saf dolgu sesleri: "ıı", "ee", "ee ee", "hmm", "ııı", "öö", "ee şey" gibi anlamı olmayan duraksamalar.
- Kekemelik/yarım başlangıç: aynı kelimenin/hecenin takılı tekrarı ("bu-bu-bu bugün", "ben ben gittim" → fazlalık "ben").
- Hatalı çekim (multi-take): konuşmacı aynı cümleyi baştan tekrar denediğinde, SADECE en son ve en akıcı denemeyi tut, önceki yarım/bozuk denemeleri sil.

ASLA SİLME (bunlar anlam taşır):
- Bağlaçlar ve edatlar: "ve", "ama", "ancak", "fakat", "çünkü", "ki", "ya da", "veya", "için", "ile", "de/da", "ise", "gibi", "kadar" vb.
- İçerik kelimeleri: isim, fiil, sıfat, zarf — cümlenin anlamını taşıyan hiçbir kelime.
- Tek başına geçen, bağlam içinde anlamlı normal kelimeler.

Kararsız kaldığında SİLME — kelimeyi koru. Az silmek çok silmekten iyidir.

ID'ler sana gönderilen string değerlerdir (örn. "k3j9fa2"); onları AYNEN, değiştirmeden döndür (sayıya çevirme).
SADECE şu JSON formatında yanıt ver, başka hiçbir açıklama yazma:
{"deleted_word_ids":["<silinecek kelimenin id'si>"],"reasons":[{"id":"<id>","text":"<kısa sebep: Dolgu | Kekemelik | Hatalı Çekim>"}]}`;

  async function cleanTranscriptWithAI(onStatus) {
    const settings = _loadSettings();
    const apiKey   = settings.apiKey || '';
    const model    = settings.model  || 'gpt-4o-mini';

    if (!apiKey) throw new Error('AI API Key girilmemiş. AI Editör sekmesinden anahtarı girin.');

    const activeWords = TranscriptStore.getWords().map(w => ({ id: w.id, word: w.word }));
    if (!activeWords.length) throw new Error('Transkript boş.');

    onStatus && onStatus('API\'ye istek gönderiliyor…');

    const userContent = 'Transkript kelimeleri (JSON):\n' + JSON.stringify(activeWords);
    const isAnthropic = model.startsWith('claude');

    let responseText;

    if (typeof require === 'function') {
      responseText = await _callApiNode(apiKey, model, isAnthropic, SYSTEM_PROMPT, userContent, onStatus);
    } else {
      responseText = await _callApiFetch(apiKey, model, isAnthropic, SYSTEM_PROMPT, userContent, onStatus);
    }

    let parsed;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      throw new Error('AI yanıtı JSON olarak çözümlenemedi: ' + responseText.slice(0, 200));
    }

    const deletedIds = parsed.deleted_word_ids || [];
    _reasons = parsed.reasons || [];

    const reasonMap = {};
    _reasons.forEach(r => { reasonMap[String(r.id)] = r.text; });

    // Tek undo anlık görüntüsü (Alt+Z ile tüm AI geçişi geri alınabilir)
    TranscriptStore.pushUndo(deletedIds.map(String));

    let matched = 0;
    deletedIds.forEach(id => {
      const w = TranscriptStore.getWords(true).find(x => String(x.id) === String(id));
      if (w) {
        // Yumuşak işaret: görünür kalır (üstü çizili), alt çubuktan kesilir
        w.aiDeleted = true;
        w.aiReason  = reasonMap[String(id)] || 'AI kesimi';
        matched++;
      }
    });

    TranscriptStore.notifyAll();

    return { deletedCount: matched, reasons: _reasons };
  }

  async function _callApiNode(apiKey, model, isAnthropic, systemPrompt, userContent, onStatus) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const body  = Buffer.from(JSON.stringify(
        isAnthropic
          ? { model, max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: userContent }] }
          : { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }], response_format: { type: 'json_object' } }
      ));

      const opts = {
        hostname: isAnthropic ? 'api.anthropic.com' : 'api.openai.com',
        path    : isAnthropic ? '/v1/messages' : '/v1/chat/completions',
        method  : 'POST',
        headers : {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          ...(isAnthropic
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { 'Authorization': 'Bearer ' + apiKey })
        }
      };

      const req = https.request(opts, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.error) { reject(new Error('AI API: ' + (data.error.message || JSON.stringify(data.error)))); return; }
            const text = isAnthropic
              ? (data.content && data.content[0] && data.content[0].text)
              : (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
            resolve(text || '');
          } catch (e) { reject(new Error('API yanıtı çözümlenemedi: ' + raw.slice(0, 200))); }
        });
      });
      req.on('error', e => reject(new Error('HTTPS hatası: ' + e.message)));
      req.write(body);
      req.end();
    });
  }

  async function _callApiFetch(apiKey, model, isAnthropic, systemPrompt, userContent, onStatus) {
    const url  = isAnthropic ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions';
    const body = isAnthropic
      ? { model, max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: userContent }] }
      : { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }], response_format: { type: 'json_object' } };

    const headers = {
      'Content-Type': 'application/json',
      ...(isAnthropic
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : { 'Authorization': 'Bearer ' + apiKey })
    };

    const res  = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.error) throw new Error('AI API: ' + (data.error.message || JSON.stringify(data.error)));
    return isAnthropic
      ? (data.content && data.content[0] && data.content[0].text)
      : (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
  }

  const PUNCT_PROMPT = `Sen bir Türkçe metin editörüsün. Sana sırayla kelimeler [{id, word}] verilecek.
Görevin: Türkçe dil bilgisine uygun noktalama işaretlerini (. , ? ! : ; …) eklemek ve cümle başlarını ile özel adları büyük harfle düzeltmek.

KESİN KURALLAR:
- Kelime EKLEME, SİLME, BİRLEŞTİRME veya SIRASINI DEĞİŞTİRME. Sadece her kelimenin yazımını düzelt.
- Noktalama işaretini ait olduğu kelimeye bitişik yaz (örn. "evet," / "tamam." / "gidelim").
- Soru cümlelerinde "mı/mi/mu/mü" veya soru sözcüğü varsa cümle sonuna "?" koy.
- Gönderilen id'leri ve kelime SAYISINI birebir koru.

SADECE şu JSON ile yanıt ver, başka açıklama yazma:
{"words":[{"id":"<id>","word":"<düzeltilmiş kelime>"}]}`;

  /** AI Editör anahtarı yoksa Whisper (OpenAI) anahtarına düş. */
  function _resolveKeyModel() {
    const s = _loadSettings();
    let apiKey = (s.apiKey || '').trim();
    let model  = s.model || '';
    if (!apiKey && typeof APIManager !== 'undefined' && APIManager.getApiKey) {
      apiKey = APIManager.getApiKey();
      if (!model) model = 'gpt-4o-mini';
    }
    if (!model) model = 'gpt-4o-mini';
    return { apiKey, model, isAnthropic: model.indexOf('claude') === 0 };
  }

  async function addPunctuationWithAI(onStatus) {
    const { apiKey, model, isAnthropic } = _resolveKeyModel();
    if (!apiKey) throw new Error('API anahtarı yok. Ayarlar (OpenAI) veya AI Editör sekmesinden girin.');

    const words = TranscriptStore.getWords().map(w => ({ id: w.id, word: w.word }));
    if (!words.length) throw new Error('Transkript boş.');

    onStatus && onStatus('Noktalama için AI\'ya gönderiliyor…');
    const userContent = 'Kelimeler (JSON):\n' + JSON.stringify(words);

    let responseText;
    if (typeof require === 'function') {
      responseText = await _callApiNode(apiKey, model, isAnthropic, PUNCT_PROMPT, userContent, onStatus);
    } else {
      responseText = await _callApiFetch(apiKey, model, isAnthropic, PUNCT_PROMPT, userContent, onStatus);
    }

    let parsed;
    try {
      const m = responseText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : responseText);
    } catch (e) {
      throw new Error('AI yanıtı çözümlenemedi: ' + String(responseText).slice(0, 200));
    }
    const items = parsed.words || parsed.items || [];
    const count = TranscriptStore.applyWordTexts(items);
    return { count };
  }

  function getReasons() { return _reasons; }

  return { initUI, cleanTranscriptWithAI, addPunctuationWithAI, getReasons };
})();


/* ══════════════════════════════════════════════════════════════════
   E. SubtitleEngine  –  SRT Altyazı Üretimi
   ══════════════════════════════════════════════════════════════════ */
const SubtitleEngine = (() => {
  const _STORAGE_KEY = 'rfai_subtitle_style_v2';

  let _style = {
    fontFamily       : 'Arial',
    fontSize         : 48,
    color            : '#FFFFFF',
    strokeWidth      : 2,
    strokeColor      : '#000000',
    shadowEnabled    : true,
    highlightEnabled : true,
    bounceEnabled    : true,
    highlightColor   : '#FF6B3D',
    positionX        : 50,
    positionY        : 85,
    alignment        : 'center',
    subtitleStyle    : 'corporate',
    subtitleMode     : 'line',
    bgBoxEnabled     : false,
    bgBoxColor       : '#000000',
    bgBoxOpacity     : 75,
    passiveColor     : '#AAAAAA',
    allCaps          : false
  };

  function _loadFromStorage() {
    try {
      const saved = localStorage.getItem(_STORAGE_KEY);
      if (saved) Object.assign(_style, JSON.parse(saved));
    } catch (e) {}
  }

  function _saveToStorage() {
    try { localStorage.setItem(_STORAGE_KEY, JSON.stringify(_style)); } catch (e) {}
  }

  _loadFromStorage();

  function getStyle()        { return { ..._style }; }
  function setStyle(updates) { Object.assign(_style, updates); _saveToStorage(); _updatePreview(); }

  function _getAlignmentTag(align, x, y) {
    let tag = 2; // Bottom-Center
    if (align === 'left') {
      if (y < 33) tag = 7;
      else if (y < 66) tag = 4;
      else tag = 1;
    } else if (align === 'center') {
      if (y < 33) tag = 8;
      else if (y < 66) tag = 5;
      else tag = 2;
    } else if (align === 'right') {
      if (y < 33) tag = 9;
      else if (y < 66) tag = 6;
      else tag = 3;
    }
    return `{\\an${tag}}`;
  }

  function _updatePreview() {
    const preview = document.getElementById('subtitlePreviewText');
    if (!preview) return;
    preview.style.fontFamily       = _style.fontFamily;
    preview.style.fontSize         = Math.max(12, Math.round(_style.fontSize * 0.35)) + 'px';
    preview.style.color            = _style.color;
    preview.style.webkitTextStroke = _style.strokeWidth + 'px ' + _style.strokeColor;
    preview.style.textShadow       = _style.shadowEnabled ? '2px 2px 4px rgba(0,0,0,.85)' : 'none';

    preview.style.left = (_style.positionX !== undefined ? _style.positionX : 50) + '%';
    preview.style.top  = (_style.positionY !== undefined ? _style.positionY : 85) + '%';

    preview.className = 'subtitle-preview-text';
    if (_style.alignment) {
      preview.classList.add('align-' + _style.alignment);
    }

    // Vurgu ve bounce önizlemeye yansır
    const hlColor = _style.highlightEnabled ? _style.highlightColor : _style.color;
    const hlClass = _style.bounceEnabled ? 'hl' : 'hl no-bounce';
    let demo = _style.allCaps ? 'MERHABA DÜNYA BU BIR TEST' : 'Merhaba dünya bu bir test';
    const word = _style.allCaps ? 'DÜNYA' : 'dünya';
    demo = demo.replace(word, `<span class="${hlClass}" style="color:${hlColor}">${word}</span>`);
    preview.innerHTML = demo;
  }

  /**
   * SRT dosyası oluştur ve Premiere'e aktar.
   */
  async function generateSubtitles() {
    const segmented = TranscriptStore.getSegmentedWords();
    if (segmented.length === 0) {
      throw new Error('Transkript boş. Önce transkript oluşturun.');
    }

    const alignTag = _getAlignmentTag(_style.alignment, _style.positionX, _style.positionY);

    const segments = segmented.map(wordArr => ({
      text : alignTag + wordArr.map(w => _style.allCaps ? w.word.toUpperCase() : w.word).join(' '),
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

  /**
   * Altyazıları Premiere timeline'ına native caption track olarak ekler.
   * SRT üretir → projeye aktarır → caption track'e yerleştirir (best-effort).
   */
  async function injectToTimeline() {
    const segmented = TranscriptStore.getSegmentedWords();
    if (segmented.length === 0) throw new Error('Transkript boş. Önce transkript oluşturun.');

    // Native caption track → satır bazlı düz metin (maks ~8 kelime / 42 karakter)
    const segments = _buildCaptionSegments(segmented);

    return new Promise((resolve, reject) => {
      const cs = window.getCSInterface ? window.getCSInterface() : null;
      const script = `createCaptionTrackFromSegments(${JSON.stringify(JSON.stringify(segments))})`;
      if (cs) {
        cs.evalScript(script, result => {
          try { resolve(JSON.parse(result)); }
          catch (e) { reject(new Error('ExtendScript yanıtı işlenemedi: ' + e.message)); }
        });
      } else {
        reject(new Error('Premiere Pro bağlantısı yok.'));
      }
    });
  }

  /**
   * Segment gruplarını caption satırlarına böler. Görünüm moduna göre:
   *  - word: her kelime ayrı caption
   *  - full: her segment grubu tek caption
   *  - line (varsayılan): maks ~8 kelime / 42 karakter
   */
  function _buildCaptionSegments(segmented) {
    const mode = _style.subtitleMode || 'line';
    const cap  = w => _style.allCaps ? w.word.toUpperCase() : w.word;
    const segments = [];

    segmented.forEach(group => {
      if (!group.length) return;

      if (mode === 'word') {
        group.forEach(w => segments.push({ text: cap(w), start: w.start, end: w.end }));
        return;
      }
      if (mode === 'full') {
        segments.push({ text: group.map(cap).join(' '), start: group[0].start, end: group[group.length - 1].end });
        return;
      }

      // line modu — maks 8 kelime / 42 karakter
      let i = 0;
      while (i < group.length) {
        const slice = [];
        let chars = 0;
        while (i < group.length && slice.length < 8 && (chars + group[i].word.length + 1) <= 42) {
          chars += group[i].word.length + 1;
          slice.push(group[i]);
          i++;
        }
        if (slice.length === 0) { slice.push(group[i]); i++; } // tek başına uzun kelime
        segments.push({ text: slice.map(cap).join(' '), start: slice[0].start, end: slice[slice.length - 1].end });
      }
    });
    return segments;
  }

  /**
   * Transkripti otomatik segment break'lere böler.
   * @param {number} maxChars        Satır başına maks karakter (varsayılan 35)
   * @param {number} maxDuration     Segment maks. süresi saniye (varsayılan 3.0)
   * @param {number} silenceThreshold Sessizlik eşiği saniye (varsayılan 0.5)
   */
  /**
   * Cümle-farkında otomatik bölme: önce cümle sonlarından (. ! ? …) böler,
   * cümle uzunsa virgül/uzun sessizlik/karakter limitinde alt-böler.
   * @param {number} maxChars   Satır başına maks karakter (varsayılan 42)
   * @param {number} maxDuration Segment maks. süresi sn (varsayılan 6.0)
   * @param {number} silenceThreshold Sessizlik eşiği sn (varsayılan 0.6)
   */
  function autoSegmentSubtitles(maxChars, maxDuration, silenceThreshold) {
    maxChars         = maxChars         || 42;
    maxDuration      = maxDuration      || 6.0;
    silenceThreshold = silenceThreshold || 0.6;

    const words = TranscriptStore.getWords();
    if (words.length < 2) return 0;

    const SENT_END   = /[.!?…]["')\]]?$/;   // cümle sonu
    const CLAUSE_END = /[,;:]["')\]]?$/;     // bağlaç/virgül

    const breakIds = [];
    let segStart   = 0;

    const flush = (i) => { breakIds.push(words[i].id); segStart = i + 1; };

    for (let i = 0; i < words.length - 1; i++) {
      const w     = words[i];
      const next  = words[i + 1];
      const chars = words.slice(segStart, i + 1).map(x => x.word).join(' ').length;
      const dur   = w.end - words[segStart].start;
      const gap   = next.start - w.end;

      if (SENT_END.test(w.word) && chars >= 4) {            // cümle sonu → her zaman böl
        flush(i); continue;
      }
      if (chars >= maxChars || dur >= maxDuration) {         // limit aşıldı → böl
        flush(i); continue;
      }
      if (gap >= silenceThreshold && chars >= 8) {           // uzun sessizlik → böl
        flush(i); continue;
      }
      if (CLAUSE_END.test(w.word) && chars >= 28) {          // uzun cümlede virgülde böl
        flush(i); continue;
      }
    }

    TranscriptStore.setSegmentBreaks(breakIds);
    return breakIds.length;
  }

  return { getStyle, setStyle, generateSubtitles, injectToTimeline, autoSegmentSubtitles };
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

    // Yapışkan çubuk: Uygula + Geri Al
    const pendingApplyBtn = document.getElementById('pendingApplyBtn');
    if (pendingApplyBtn) pendingApplyBtn.addEventListener('click', _onApplyDelete);
    const pendingUndoBtn = document.getElementById('pendingUndoBtn');
    if (pendingUndoBtn) pendingUndoBtn.addEventListener('click', () => {
      if (TranscriptStore.undo()) toast('Geri alındı (Alt+Z).', 'info');
      else toast('Geri alınacak işlem yok.', 'warn');
    });

    // Altyazı oluştur
    const genSubBtn = document.getElementById('generateSubtitlesBtn');
    if (genSubBtn) genSubBtn.addEventListener('click', _onGenerateSubtitles);

    // Timeline enjeksiyon
    const injectBtn = document.getElementById('injectTimelineBtn');
    if (injectBtn) injectBtn.addEventListener('click', _onInjectTimeline);

    // AI Editor
    AIEditorEngine.initUI();
    const aiCleanBtn = document.getElementById('runAiCleanBtn');
    if (aiCleanBtn) aiCleanBtn.addEventListener('click', _onRunAiClean);

    // Otomatik segment bölme
    const autoSegBtn = document.getElementById('autoSegmentBtn');
    if (autoSegBtn) autoSegBtn.addEventListener('click', () => {
      const n = SubtitleEngine.autoSegmentSubtitles();
      toast(n > 0 ? `${n + 1} cümle bloğuna bölündü.` : 'Bölme yapılamadı (önce transkript oluşturun).', n > 0 ? 'success' : 'warn');
      log('Otomatik bölme: ' + n + ' kesim noktası.', 'info');
    });

    // AI Türkçe noktalama
    const punctuateBtn = document.getElementById('punctuateBtn');
    if (punctuateBtn) punctuateBtn.addEventListener('click', _onPunctuate);

    // Bul & Değiştir
    const frToggle = document.getElementById('findReplaceToggle');
    const frBar    = document.getElementById('findReplaceBar');
    if (frToggle && frBar) {
      frToggle.addEventListener('click', () => {
        const show = frBar.style.display === 'none';
        frBar.style.display = show ? 'flex' : 'none';
        frToggle.classList.toggle('active', show);
        if (show) document.getElementById('findInput')?.focus();
      });
    }
    const replaceAllBtn = document.getElementById('replaceAllBtn');
    if (replaceAllBtn) replaceAllBtn.addEventListener('click', _onReplaceAll);
    const replaceInput = document.getElementById('replaceInput');
    if (replaceInput) replaceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') _onReplaceAll(); });

    // Stil kontrolleri
    _initStyleControls();
    _renderFillerChips();
    _initDragAndDrop();

    // Font tarama ve yukleme
    setTimeout(() => {
      const cs = window.getCSInterface ? window.getCSInterface() : null;
      if (cs) {
        log('Yerel fontlar taranıyor…', 'info');
        cs.evalScript('getAvailableFonts()', (result) => {
          try {
            const res = JSON.parse(result);
            if (res && res.success && res.fonts && res.fonts.length > 0) {
              _injectFonts(res.fonts);
              _populateFontDropdown(res.fonts);
              log(`${res.fonts.length} adet yerel font yüklendi.`, 'success');
            } else {
              log('Yerel font bulunamadı veya fonts/ klasörü boş.', 'info');
            }
          } catch (e) {
            log('Font yükleme hatası: ' + e.message, 'error');
          }
        });
      }
    }, 500);

    // Alt+Z Geri Alma (Premiere'in Ctrl+Z ile çakışmaz)
    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (TranscriptStore.undo()) {
          toast('Geri alındı (Alt+Z)', 'info');
          log('Undo uygulandı.', 'info');
        } else {
          toast('Geri alınacak işlem yok.', 'warn');
        }
      }
    });

    TranscriptEditor.init('transcriptArea');
    updateStats();

    log('Rast Flow AI hazır. 🚀', 'success');
  }

  function _injectFonts(fonts) {
    let css = '';
    fonts.forEach(f => {
      const urlPath = 'file:///' + f.file.replace(/\\/g, '/');
      const format = f.file.toLowerCase().endsWith('.otf') ? 'opentype' : 'truetype';
      css += `
        @font-face {
          font-family: '${f.name}';
          src: url('${urlPath}') format('${format}');
          font-weight: ${f.weight === 'Regular' ? 'normal' : f.weight};
          font-style: ${f.style};
        }
      `;
    });
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function _populateFontDropdown(fonts) {
    const select = document.getElementById('fontFamilySelect');
    if (!select) return;
    select.innerHTML = '<option value="Arial">Arial</option><option value="Helvetica">Helvetica</option>';
    const added = new Set(['Arial', 'Helvetica']);
    fonts.forEach(f => {
      if (!added.has(f.name)) {
        added.add(f.name);
        const opt = document.createElement('option');
        opt.value = f.name;
        opt.textContent = f.name;
        select.appendChild(opt);
      }
    });
    if (fonts.length > 0) {
      select.value = fonts[0].name;
      SubtitleEngine.setStyle({ fontFamily: fonts[0].name });
    }
  }

  function _initDragAndDrop() {
    const container = document.getElementById('subtitlePreviewContainer');
    const textEl    = document.getElementById('subtitlePreviewText');
    const inputX    = document.getElementById('positionXInput');
    const inputY    = document.getElementById('positionYInput');
    const labelX    = document.getElementById('posXLabel');
    const labelY    = document.getElementById('posYLabel');
    
    if (!container || !textEl) return;
    
    let isDragging = false;
    
    textEl.addEventListener('mousedown', (e) => {
      isDragging = true;
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const rect = container.getBoundingClientRect();
      let x = ((e.clientX - rect.left) / rect.width) * 100;
      let y = ((e.clientY - rect.top) / rect.height) * 100;
      
      x = Math.max(5, Math.min(95, Math.round(x)));
      y = Math.max(5, Math.min(95, Math.round(y)));
      
      if (inputX) { inputX.value = x; if (labelX) labelX.textContent = x; }
      if (inputY) { inputY.value = y; if (labelY) labelY.textContent = y; }
      
      textEl.style.left = x + '%';
      textEl.style.top  = y + '%';
      
      SubtitleEngine.setStyle({ positionX: x, positionY: y });
    });
    
    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
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

      // Otomatik sessizlik tarama (FFmpeg)
      await _onScanSilences();

    } catch (e) {
      toast('Hata: ' + e.message, 'error');
      log('Hata: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      _showLoading(false);
    }
  }

  async function _onScanSilences() {
    const db = parseInt(document.getElementById('silenceDbThreshold')?.value || -30);
    const minDur = parseFloat(document.getElementById('silenceMinDuration')?.value || 0.4);
    
    try {
      _showLoading(true);
      log(`FFmpeg desibel sessizlik analizi başlatılıyor (Eşik: ${db}dB, Min. Süre: ${minDur}s)…`, 'info');

      let silences = [];
      let method   = 'FFmpeg dB';
      try {
        silences = await SilenceRemover.scanSilencesFfmpeg(db, minDur);
      } catch (ffErr) {
        log('FFmpeg taraması yapılamadı (' + ffErr.message + ') — kelime boşluğu yöntemine geçiliyor.', 'warn');
      }

      // FFmpeg yoksa/sonuç boşsa: kelime zaman damgalarından boşluk tabanlı tespit
      if (!silences || silences.length === 0) {
        silences = SilenceRemover.scanSilences(minDur);
        method   = 'kelime boşluğu';
      }

      SilenceRemover.setDetectedSilences(silences);
      _silenceDeleteList = [...silences]; // Tespit edilen tüm sessizlikleri otomatik kuyruğa al

      TranscriptStore.notifyAll(); // Sessizlik bantlarıyla yeniden çiz

      const countEl = document.getElementById('silenceCount');
      if (countEl) countEl.textContent = silences.length + ' adet';

      const totalDur = silences.reduce((a, s) => a + s.duration, 0);
      const durEl    = document.getElementById('silenceTotalDur');
      if (durEl) durEl.textContent = totalDur.toFixed(1) + 's';

      toast(`${silences.length} sessizlik tespit edildi (${method}, toplam ${totalDur.toFixed(1)}s).`,
        silences.length > 0 ? 'warn' : 'info');
      log(`${silences.length} sessizlik bulundu (${method}, toplam: ${totalDur.toFixed(1)}s)`, 'success');

    } catch (e) {
      toast('Sessizlik tarama hatası: ' + e.message, 'error');
      log('Sessizlik tarama hatası: ' + e.message, 'error');
    } finally {
      _showLoading(false);
    }
  }

  function _onAddAllSilencesToList() {
    const silences = SilenceRemover.getDetectedSilences();
    if (silences.length === 0) {
      toast('Önce "Sessizlikleri Tara" butonuna basın.', 'warn');
      return;
    }
    _silenceDeleteList = [...silences];
    TranscriptStore.notifyAll();
    toast(`${_silenceDeleteList.length} sessizlik silim listesine eklendi.`, 'info');
    log(_silenceDeleteList.length + ' sessizlik silim listesine alındı.', 'info');
  }

  function _onScanRepeats() {
    const method = document.getElementById('repeatMethod')?.value || 'sliding';
    const groups = SilenceRemover.findRepeats(method);
    TranscriptStore.notifyAll();

    const listEl = document.getElementById('repeatList');
    if (listEl) {
      listEl.innerHTML = '';
      if (groups.length === 0) {
        listEl.innerHTML = '<div style="font-size:11px;color:var(--text-2);padding:6px 0;">Tekrar bulunamadı.</div>';
      } else {
        groups.forEach(group => {
          const card = document.createElement('div');
          card.className = 'repeat-card';

          const info = document.createElement('div');
          info.className = 'repeat-card-info';
          info.innerHTML = `<div class="repeat-card-phrase">"${group.phrase}"</div>
            <div class="repeat-card-meta">${group.count}x tekrar &middot; ${_fmt(group.startTime)}</div>`;

          const actions = document.createElement('div');
          actions.className = 'repeat-card-actions';

          const listenBtn = document.createElement('button');
          listenBtn.className = 'btn btn-secondary btn-sm';
          listenBtn.textContent = '▶ Dinle';
          listenBtn.addEventListener('click', () => {
            const cs = window.getCSInterface ? window.getCSInterface() : null;
            if (cs) cs.evalScript('goToTime(' + group.startTime + ')', () => {});
          });

          const keepBtn = document.createElement('button');
          keepBtn.className = 'btn btn-secondary btn-sm';
          keepBtn.textContent = 'Koru';
          keepBtn.addEventListener('click', () => {
            group.wordIds.forEach(id => TranscriptStore.restoreWord(id));
            TranscriptStore.notifyAll();
            toast('Kelimeler korundu.', 'info');
            card.remove();
          });

          actions.appendChild(listenBtn);
          actions.appendChild(keepBtn);
          card.appendChild(info);
          card.appendChild(actions);
          listEl.appendChild(card);
        });
      }
    }

    if (groups.length) {
      toast(`${groups.length} tekrar grubu tespit edildi.`, 'warn');
      log(groups.length + ' tekrar grubu bulundu (' + method + ' mod).', 'warn');
    } else {
      toast('Tekrar bulunamadı.', 'info');
    }
  }

  function _onMarkFillers() {
    const count = SilenceRemover.markFillers(_fillerList);
    TranscriptStore.notifyAll();
    toast(count > 0
      ? `${count} filler işaretlendi — alt çubuktan "Premiere'e Uygula" ile kes.`
      : 'Filler kelime bulunamadı.', count > 0 ? 'warn' : 'info');
  }

  async function _onPunctuate() {
    const btn = document.getElementById('punctuateBtn');
    if (TranscriptStore.getWords().length === 0) { toast('Önce transkript oluşturun.', 'warn'); return; }
    if (btn) btn.disabled = true;
    _showLoading(true);
    try {
      const lt = document.getElementById('loadingText');
      const { count } = await AIEditorEngine.addPunctuationWithAI((msg) => { if (lt) lt.textContent = msg; });
      toast(`Türkçe noktalama eklendi (${count} kelime güncellendi).`, 'success');
      log('AI noktalama tamamlandı: ' + count + ' kelime.', 'success');
    } catch (e) {
      toast('Noktalama hatası: ' + e.message, 'error');
      log('Noktalama hatası: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
      _showLoading(false);
    }
  }

  function _onReplaceAll() {
    const find = (document.getElementById('findInput')?.value || '').trim();
    const rep  = document.getElementById('replaceInput')?.value || '';
    const cs   = document.getElementById('findCaseSensitive')?.checked === true;
    if (!find) { toast('Aranacak kelimeyi yazın.', 'warn'); return; }
    const n = TranscriptStore.replaceAll(find, rep, cs);
    toast(n ? `${n} kelime "${rep}" olarak değiştirildi.` : `"${find}" bulunamadı.`, n ? 'success' : 'info');
    log(`Bul & Değiştir: "${find}" → "${rep}" (${n} eşleşme).`, 'info');
  }

  async function _onApplyDelete() {
    const btns      = [document.getElementById('applyDeleteBtn'), document.getElementById('pendingApplyBtn')].filter(Boolean);
    const doRipple  = document.getElementById('rippleDeleteToggle')?.checked !== false;
    btns.forEach(b => b.disabled = true);

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
        TranscriptStore.markAppliedCuts(); // bekleyen kesimler "uygulandı" → çubuk temizlenir, görünüm güncellenir
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
      btns.forEach(b => b.disabled = false);
      _showLoading(false);
      updatePendingBar();
    }
  }

  async function _onRunAiClean() {
    const btn = document.getElementById('runAiCleanBtn');
    const statusBar = document.getElementById('aiStatusBar');
    btn.disabled = true;
    _showLoading(true);

    const setStatus = msg => { if (statusBar) statusBar.textContent = msg; };
    setStatus('Hazırlanıyor…');

    try {
      const { deletedCount, reasons } = await AIEditorEngine.cleanTranscriptWithAI(setStatus);

      setStatus(`${deletedCount} kelime AI tarafından silindi.`);

      const statsEl = document.getElementById('aiStats');
      const delCntEl = document.getElementById('aiDeletedCount');
      const reasCntEl = document.getElementById('aiReasonCount');
      if (statsEl)  { statsEl.style.display = 'flex'; }
      if (delCntEl)  delCntEl.textContent  = deletedCount;
      if (reasCntEl) reasCntEl.textContent = reasons.length;

      // Sebep listesini doldur
      const listEl = document.getElementById('aiReasonsList');
      const section = document.getElementById('aiReasonsSection');
      if (listEl && reasons.length > 0) {
        listEl.innerHTML = '';
        if (section) section.style.display = 'block';
        reasons.forEach(r => {
          const item = document.createElement('div');
          item.className = 'ai-reason-item';

          const wordEl = TranscriptStore.getWords(true).find(w => String(w.id) === String(r.id));
          const wordText = wordEl ? wordEl.word : '(?)';

          item.innerHTML = `
            <div class="ai-reason-word">"${wordText}"</div>
            <div class="ai-reason-text">${r.text}</div>
            <button class="ai-reason-restore" data-id="${r.id}">Koru</button>`;

          item.querySelector('.ai-reason-restore').addEventListener('click', (e) => {
            const id = String(e.currentTarget.dataset.id);
            TranscriptStore.restoreWord(id);
            document.querySelectorAll(`.word[data-id="${id}"]`).forEach(s => {
              s.classList.remove('ai-deleted');
              delete s.dataset.aiReason;
            });
            item.remove();
            setStatus('Kelime korundu.');
          });

          listEl.appendChild(item);
        });
      }

      toast(`AI: ${deletedCount} kelime temizlendi.`, 'success');
      log('AI temizleme tamamlandı: ' + deletedCount + ' kelime.', 'success');

    } catch (e) {
      setStatus('Hata: ' + e.message);
      toast('AI Hata: ' + e.message, 'error');
      log('AI Hata: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      _showLoading(false);
    }
  }

  async function _onInjectTimeline() {
    const btn = document.getElementById('injectTimelineBtn');
    btn.disabled = true;
    _showLoading(true);
    try {
      const result = await SubtitleEngine.injectToTimeline();
      if (result.success && result.placedOnTimeline) {
        toast(`${result.segmentCount} altyazı caption track'e eklendi ✓`, 'success');
        log(`Caption track oluşturuldu: ${result.segmentCount} altyazı.`, 'success');
      } else if (result.success && !result.placedOnTimeline) {
        toast(result.note || 'SRT projeye aktarıldı — caption track\'e manuel sürükleyin.', 'warn');
        log('Caption: ' + (result.note || 'projeye aktarıldı, manuel yerleştirme gerekiyor.'), 'warn');
      } else {
        toast('Caption hatası: ' + result.error, 'error');
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

  function _initStyleControls() {
    const controls = {
      fontFamily    : 'fontFamilySelect',
      fontSize      : 'fontSizeInput',
      color         : 'textColorInput',
      strokeWidth   : 'strokeWidthInput',
      strokeColor   : 'strokeColorInput',
      highlightColor: 'highlightColorInput',
      positionX     : 'positionXInput',
      positionY     : 'positionYInput',
      subtitleStyle : 'subtitleStyleSelect',
      bgBoxColor    : 'bgBoxColor',
      bgBoxOpacity  : 'bgOpacityInput',
      passiveColor  : 'passiveColorInput'
    };

    // Restore saved values
    const saved = SubtitleEngine.getStyle();
    Object.entries(controls).forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (saved[key] !== undefined) el.value = saved[key];
      el.addEventListener('input', () => {
        const update = {};
        update[key] = el.type === 'number' || el.type === 'range'
          ? parseFloat(el.value) : el.value;
        SubtitleEngine.setStyle(update);
      });
    });

    // bgBoxToggle
    const bgBoxToggle = document.getElementById('bgBoxToggle');
    const bgBoxSettings = document.getElementById('bgBoxSettings');
    if (bgBoxToggle) {
      bgBoxToggle.checked = saved.bgBoxEnabled || false;
      if (bgBoxSettings) bgBoxSettings.classList.toggle('visible', bgBoxToggle.checked);
      bgBoxToggle.addEventListener('change', () => {
        SubtitleEngine.setStyle({ bgBoxEnabled: bgBoxToggle.checked });
        if (bgBoxSettings) bgBoxSettings.classList.toggle('visible', bgBoxToggle.checked);
      });
    }

    // allCapsToggle
    const allCapsToggle = document.getElementById('allCapsToggle');
    if (allCapsToggle) {
      allCapsToggle.checked = saved.allCaps || false;
      allCapsToggle.addEventListener('change', () => {
        SubtitleEngine.setStyle({ allCaps: allCapsToggle.checked });
      });
    }

    // Önizleme toggle'ları: gölge / bounce / vurgu
    const _wireToggle = (id, styleKey) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (saved[styleKey] !== undefined) el.checked = saved[styleKey];
      el.addEventListener('change', () => SubtitleEngine.setStyle({ [styleKey]: el.checked }));
    };
    _wireToggle('shadowToggle',    'shadowEnabled');
    _wireToggle('bounceToggle',    'bounceEnabled');
    _wireToggle('highlightToggle', 'highlightEnabled');

    // Görünüm modu (kelime / satır / tüm metin) — caption üretimini etkiler
    const modeSel = document.getElementById('subtitleModeSelect');
    if (modeSel) {
      if (saved.subtitleMode) modeSel.value = saved.subtitleMode;
      modeSel.addEventListener('change', () => SubtitleEngine.setStyle({ subtitleMode: modeSel.value }));
    }

    // Restore bgOpacity label
    const bgOpacityLabel = document.getElementById('bgOpacityLabel');
    if (bgOpacityLabel && saved.bgBoxOpacity !== undefined) {
      bgOpacityLabel.textContent = saved.bgBoxOpacity;
    }

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

    // Position Presets
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const x = parseInt(btn.dataset.x);
        const y = parseInt(btn.dataset.y);
        
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        
        const inputX = document.getElementById('positionXInput');
        const inputY = document.getElementById('positionYInput');
        if (inputX) { inputX.value = x; const lx = document.getElementById('posXLabel'); if (lx) lx.textContent = x; }
        if (inputY) { inputY.value = y; const ly = document.getElementById('posYLabel'); if (ly) ly.textContent = y; }
        
        SubtitleEngine.setStyle({ positionX: x, positionY: y });
      });
    });

    // Alignment Buttons
    document.querySelectorAll('.align-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const align = btn.dataset.align;
        
        document.querySelectorAll('.align-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        
        SubtitleEngine.setStyle({ alignment: align });
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

  function isSilenceQueued(silence) {
    return _silenceDeleteList.some(s => Math.abs(s.start - silence.start) < 0.01 && Math.abs(s.end - silence.end) < 0.01);
  }

  function toggleSilenceQueue(silence, element) {
    const idx = _silenceDeleteList.findIndex(s => Math.abs(s.start - silence.start) < 0.01 && Math.abs(s.end - silence.end) < 0.01);
    if (idx >= 0) {
      _silenceDeleteList.splice(idx, 1);
      if (element) {
        element.classList.remove('queued');
        element.style.background = '#332c27';
      }
      toast('Sessizlik silim listesinden kaldırıldı.', 'info');
    } else {
      _silenceDeleteList.push(silence);
      if (element) {
        element.classList.add('queued');
        element.style.background = 'var(--red)';
      }
      toast('Sessizlik silim listesine eklendi.', 'info');
    }
    updateStats();
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

    updatePendingBar();
  }

  /** Yapışkan "Premiere'e Uygula" çubuğunu güncelle (her render'da çağrılır) */
  function updatePendingBar() {
    const bar = document.getElementById('pendingBar');
    if (!bar) return;

    const wordRanges = TranscriptStore.getDeleteRanges();
    const allRanges  = [...wordRanges, ..._silenceDeleteList];
    const count      = allRanges.length;
    const dur        = allRanges.reduce((a, r) => a + Math.max(0, r.end - r.start), 0);

    const countEl = document.getElementById('pendingCount');
    const durEl   = document.getElementById('pendingDur');
    if (countEl) countEl.textContent = count;
    if (durEl)   durEl.textContent   = dur.toFixed(1) + 's';

    bar.classList.toggle('visible', count > 0);
  }

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

  return { init, updateStats, toggleSilenceQueue, isSilenceQueued, log, toast };
})();

/* ── DOM Hazır ── */
document.addEventListener('DOMContentLoaded', () => {
  UIController.init();
});
