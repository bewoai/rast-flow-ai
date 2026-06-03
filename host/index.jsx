/**
 * host/index.jsx — Rast Flow AI  |  ExtendScript Motoru
 * Adobe Premiere Pro CEP Eklentisi
 *
 * İçerik:
 *  1. JSON Polyfill  (ES3 uyumluluğu)
 *  2. getPrimarySourceForRange() – Kaynak medya yolu + aralık (FFmpeg için)
 *  3. getSequenceInfo()      – Aktif sekans metaverisi
 *  4. rippleDeleteRanges()   – Zaman aralıklarını sil + boşlukları kapat
 *  5. generateAndImportSRT() – SRT altyazı dosyası üret + Premiere'e aktar
 *  6. addKeyframesToLayer()  – Scale bounce keyframe'leri
 *  7. goToTime()             – Playhead konumlandırma
 *  8. getAvailableFonts()    – Yerel font klasörü taraması
 */

/* ══════════════════════════════════════════════════════════════════
   1. JSON Polyfill  (ExtendScript ES3'te JSON yoktur)
   ══════════════════════════════════════════════════════════════════ */
if (typeof JSON === "undefined") {
  JSON = {};
}

if (typeof JSON.stringify !== "function") {
  JSON.stringify = function (value, replacer, space) {
    var type = typeof value;
    if (value === null)     return "null";
    if (type === "boolean") return value ? "true" : "false";
    if (type === "number")  return isFinite(value) ? String(value) : "null";
    if (type === "string")  return '"' + value.replace(/\\/g, "\\\\")
                                               .replace(/"/g, '\\"')
                                               .replace(/\n/g, "\\n")
                                               .replace(/\r/g, "\\r")
                                               .replace(/\t/g, "\\t") + '"';
    if (type === "object") {
      if (value instanceof Array) {
        var arrParts = [];
        for (var i = 0; i < value.length; i++) {
          arrParts.push(JSON.stringify(value[i]));
        }
        return "[" + arrParts.join(",") + "]";
      }
      var objParts = [];
      for (var key in value) {
        if (value.hasOwnProperty(key)) {
          var v = JSON.stringify(value[key]);
          if (v !== undefined) {
            objParts.push('"' + key + '":' + v);
          }
        }
      }
      return "{" + objParts.join(",") + "}";
    }
    return undefined;
  };
}

if (typeof JSON.parse !== "function") {
  JSON.parse = function (text) {
    try {
      return eval("(" + text + ")");
    } catch (e) {
      throw new Error("JSON.parse hatası: " + e.message);
    }
  };
}

/* ══════════════════════════════════════════════════════════════════
   2. getPrimarySourceForRange()  — Kaynak medya tabanlı (FFmpeg ile)
   ══════════════════════════════════════════════════════════════════ */

function getPrimarySourceForRange(useInOutOnly) {
  try {
    if (typeof useInOutOnly === "string") {
      useInOutOnly = (useInOutOnly === "true" || useInOutOnly === "1");
    }

    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "Aktif sekans bulunamadı." });

    var rStart, rEnd, mode;
    if (useInOutOnly) {
      var inS  = _toSeconds(seq.getInPoint());
      var outS = _toSeconds(seq.getOutPoint());
      if (!((outS > inS) && (outS > 0))) {
        return JSON.stringify({
          success: false,
          error  : "Timeline'da geçerli bir In/Out aralığı yok. I ve O tuşlarıyla aralık işaretleyin " +
                   "veya 'Sadece In/Out aralığı' seçeneğini kapatın."
        });
      }
      rStart = inS; rEnd = outS; mode = "inout";
    } else {
      rStart = 0; rEnd = _toSeconds(seq.end); mode = "full";
    }

    var clip = _findPrimaryClip(seq, rStart, rEnd);
    if (!clip) {
      return JSON.stringify({ success: false, error: "İstenen aralıkta medya klibi bulunamadı." });
    }

    var path = "";
    try {
      if (clip.projectItem && clip.projectItem.getMediaPath) {
        path = clip.projectItem.getMediaPath();
      }
    } catch (e) { path = ""; }
    if (!path) {
      return JSON.stringify({ success: false, error: "Klibin kaynak medya dosyası okunamadı (sentetik/nested klip olabilir)." });
    }

    var clipStart = _toSeconds(clip.start);
    var clipEnd   = _toSeconds(clip.end);
    var clipIn    = _toSeconds(clip.inPoint);

    var rs = Math.max(rStart, clipStart);
    var re = Math.min(rEnd, clipEnd);
    if (re <= rs) {
      return JSON.stringify({ success: false, error: "Geçerli bir ses aralığı hesaplanamadı." });
    }

    var srcStart = clipIn + (rs - clipStart);
    var duration = re - rs;

    return JSON.stringify({
      success      : true,
      path         : path,
      srcStart     : srcStart,
      duration     : duration,
      timelineStart: rs,
      mode         : mode
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

function _toSeconds(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "object" && val.seconds !== undefined) return parseFloat(val.seconds);
  if (typeof val === "object" && val.ticks   !== undefined) return parseFloat(val.ticks) / 254016000000;
  var n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function _findPrimaryClip(seq, rStart, rEnd) {
  var sel = _firstSelectedClip(seq);
  if (sel) return sel;

  var best = null, bestStart = 1e15;

  function scan(tracks) {
    for (var t = 0; t < tracks.numTracks; t++) {
      var tr = tracks[t];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var cl = tr.clips[c];
        var s = _toSeconds(cl.start);
        var e = _toSeconds(cl.end);
        if (s < rEnd && e > rStart && cl.projectItem) {
          if (s < bestStart) { bestStart = s; best = cl; }
        }
      }
    }
  }

  scan(seq.videoTracks);
  if (!best) scan(seq.audioTracks);
  return best;
}

function _firstSelectedClip(seq) {
  function scan(tracks) {
    for (var t = 0; t < tracks.numTracks; t++) {
      var tr = tracks[t];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var cl = tr.clips[c];
        try { if (cl.isSelected && cl.isSelected() && cl.projectItem) return cl; } catch (e) {}
      }
    }
    return null;
  }
  return scan(seq.videoTracks) || scan(seq.audioTracks);
}

/* ══════════════════════════════════════════════════════════════════
   3. getSequenceInfo()
   ══════════════════════════════════════════════════════════════════ */

function getSequenceInfo() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ success: false, error: "Aktif sekans yok." });
    }

    var info = {
      success    : true,
      name       : seq.name,
      duration   : _toSeconds(seq.end),
      frameRate  : seq.timebase,
      videoTracks: seq.videoTracks.numTracks,
      audioTracks: seq.audioTracks.numTracks
    };
    return JSON.stringify(info);

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/* ══════════════════════════════════════════════════════════════════
   4. rippleDeleteRanges()
   ══════════════════════════════════════════════════════════════════ */

function rippleDeleteRanges(rangesJSON, ripple) {
  try {
    var ranges = JSON.parse(rangesJSON);
    var doRipple = (ripple === undefined || ripple === "true" || ripple === true);

    if (!ranges || ranges.length === 0) {
      return JSON.stringify({ success: true, deletedCount: 0 });
    }

    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ success: false, error: "Aktif sekans bulunamadı." });
    }

    if (typeof qe === "undefined") {
      try { app.enableQE(); } catch (e) {}
    }
    if (typeof qe === "undefined") {
      return JSON.stringify({ success: false, error: "QE DOM etkinleştirilemedi." });
    }

    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) {
      return JSON.stringify({ success: false, error: "QE aktif sekans alınamadı." });
    }

    var ticksPerSec = 254016000000;
    var tbTicks = parseFloat(seq.timebase) || (ticksPerSec / 25);
    var fps = ticksPerSec / tbTicks;

    ranges.sort(function (a, b) { return b.start - a.start; });

    var deletedCount = 0;

    for (var r = 0; r < ranges.length; r++) {
      var inSec  = parseFloat(ranges[r].start);
      var outSec = parseFloat(ranges[r].end);
      if (isNaN(inSec) || isNaN(outSec) || outSec <= inSec) continue;

      var inTC  = _secToTimecode(inSec,  fps);
      var outTC = _secToTimecode(outSec, fps);

      _razorAllTracks(qeSeq, inTC);
      _razorAllTracks(qeSeq, outTC);
      deletedCount += _rippleRemoveMiddle(qeSeq, inSec, outSec, doRipple);
    }

    return JSON.stringify({ success: true, deletedCount: deletedCount });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

function _secToTimecode(sec, fps) {
  var fpsR = Math.round(fps);
  if (fpsR < 1) fpsR = 25;
  var totalFrames = Math.round(sec * fpsR);
  var f = totalFrames % fpsR;
  var totalSec = Math.floor(totalFrames / fpsR);
  var s = totalSec % 60;
  var m = Math.floor(totalSec / 60) % 60;
  var h = Math.floor(totalSec / 3600);
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return p(h) + ":" + p(m) + ":" + p(s) + ":" + p(f);
}

function _razorAllTracks(qeSeq, tc) {
  var vN = qeSeq.numVideoTracks;
  for (var v = 0; v < vN; v++) {
    try { qeSeq.getVideoTrackAt(v).razor(tc); } catch (e) {}
  }
  var aN = qeSeq.numAudioTracks;
  for (var a = 0; a < aN; a++) {
    try { qeSeq.getAudioTrackAt(a).razor(tc); } catch (e) {}
  }
}

function _rippleRemoveMiddle(qeSeq, inSec, outSec, doRipple) {
  var removed = 0;
  var eps = 0.001;

  function processTrack(track) {
    if (!track) return;
    var n = track.numItems;
    for (var i = n - 1; i >= 0; i--) {
      var item;
      try { item = track.getItemAt(i); } catch (e) { continue; }
      if (!item) continue;

      var s = _qeSecs(item.start);
      var e = _qeSecs(item.end);
      if (s === null || e === null) continue;

      var itemMid = (s + e) / 2;
      if (itemMid > inSec - eps && itemMid < outSec + eps && s >= inSec - eps && e <= outSec + eps) {
        try {
          item.remove(doRipple, false);
          removed++;
        } catch (e2) {}
      }
    }
  }

  var vN = qeSeq.numVideoTracks;
  for (var v = 0; v < vN; v++) {
    try { processTrack(qeSeq.getVideoTrackAt(v)); } catch (e) {}
  }
  var aN = qeSeq.numAudioTracks;
  for (var a = 0; a < aN; a++) {
    try { processTrack(qeSeq.getAudioTrackAt(a)); } catch (e) {}
  }
  return removed;
}

function _qeSecs(t) {
  if (t === null || t === undefined) return null;
  try {
    if (typeof t === "object") {
      if (t.secs    !== undefined) return parseFloat(t.secs);
      if (t.seconds !== undefined) return parseFloat(t.seconds);
      if (t.ticks   !== undefined) return parseFloat(t.ticks) / 254016000000;
    }
    var n = parseFloat(t);
    return isNaN(n) ? null : n;
  } catch (e) { return null; }
}

/* ══════════════════════════════════════════════════════════════════
   5. generateAndImportSRT()  — Altyazı SRT üretimi + Premiere içe aktarımı
   ══════════════════════════════════════════════════════════════════ */

function generateAndImportSRT(segmentsJSON, savePathHint) {
  try {
    var segments = JSON.parse(segmentsJSON);
    if (!segments || segments.length === 0) {
      return JSON.stringify({ success: false, error: "Segment verisi boş." });
    }

    var srtContent = "";
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var startTC = _secsToSRTTime(parseFloat(seg.start));
      var endTC   = _secsToSRTTime(parseFloat(seg.end));
      srtContent += (i + 1) + "\r\n";
      srtContent += startTC + " --> " + endTC + "\r\n";
      srtContent += (seg.text || "") + "\r\n\r\n";
    }

    var baseName = "rastflow_altyazi_" + new Date().getTime() + ".srt";
    var srtPath;

    if (savePathHint && savePathHint.length > 0) {
      srtPath = savePathHint + "/" + baseName;
    } else {
      srtPath = Folder.temp.absoluteURI + "/" + baseName;
    }

    try {
      var projFile = app.project.path;
      if (projFile && projFile.length > 0) {
        var projFolder = new File(projFile).parent.absoluteURI;
        srtPath = projFolder + "/" + baseName;
      }
    } catch (e) {}

    var srtFile = new File(srtPath);
    srtFile.encoding = "UTF-8";
    if (!srtFile.open("w")) {
      srtPath = Folder.temp.absoluteURI + "/" + baseName;
      srtFile = new File(srtPath);
      srtFile.encoding = "UTF-8";
      srtFile.open("w");
    }
    srtFile.write(srtContent);
    srtFile.close();

    var fsPath = srtFile.fsName;

    var importedToProject = false;
    try {
      app.project.importFiles([fsPath], true, app.project.rootItem, false);
      importedToProject = true;
    } catch (importErr) {}

    return JSON.stringify({
      success          : true,
      srtPath          : fsPath,
      importedToProject: importedToProject
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

function _secsToSRTTime(secs) {
  var ms  = Math.round((secs % 1) * 1000);
  var s   = Math.floor(secs) % 60;
  var m   = Math.floor(secs / 60) % 60;
  var h   = Math.floor(secs / 3600);
  function p2(n) { return n < 10 ? "0" + n : String(n); }
  function p3(n) { return n < 10 ? "00" + n : (n < 100 ? "0" + n : String(n)); }
  return p2(h) + ":" + p2(m) + ":" + p2(s) + "," + p3(ms);
}

/* ══════════════════════════════════════════════════════════════════
   6. addKeyframesToLayer() — Genel Keyframe API
   ══════════════════════════════════════════════════════════════════ */

function addKeyframesToLayer(paramsJSON) {
  try {
    var p    = JSON.parse(paramsJSON);
    var seq  = app.project.activeSequence;
    var track = seq.videoTracks[p.trackIndex];
    var clip  = track.clips[p.clipIndex];

    var prop = clip.getComponentParam("Motion", p.property);
    if (!prop) {
      return JSON.stringify({ success: false, error: "Parametre bulunamadı: " + p.property });
    }

    var ticksPerSec = 254016000000;
    for (var k = 0; k < p.keyframes.length; k++) {
      var kf = p.keyframes[k];
      prop.addKeyframe(Math.round(kf.time * ticksPerSec), kf.value);
    }

    return JSON.stringify({ success: true });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/* ══════════════════════════════════════════════════════════════════
   7. goToTime() — Playhead konumlandırma
   ══════════════════════════════════════════════════════════════════ */

function goToTime(seconds) {
  try {
    var sec = parseFloat(seconds);
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "Sekans yok." });

    var t = new Time();
    t.seconds = sec;
    seq.setPlayerPosition(t.ticks);

    return JSON.stringify({ success: true });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/* ══════════════════════════════════════════════════════════════════
   8. getAvailableFonts() — Yerel font klasörü taraması
   ══════════════════════════════════════════════════════════════════ */

/**
 * Eklentinin kök dizinindeki /fonts klasöründeki .otf ve .ttf dosyalarını tarar.
 * Premiere'e yüklü fontlar yerine, bu fonksiyon dosya adlarından font isimlerini
 * türetir ve listeyi CEP tarafına döndürür.
 *
 * @returns {string} JSON — { success, fonts: [{file, name, weight, style}] }
 */
function getAvailableFonts() {
  try {
    var extPath = $.fileName;
    var extDir  = new File(extPath).parent.parent;  // host/../ → kök dizin
    var fontDir = new Folder(extDir.absoluteURI + "/fonts");

    if (!fontDir.exists) {
      return JSON.stringify({ success: false, error: "fonts/ klasörü bulunamadı: " + fontDir.fsName });
    }

    var fontFiles = fontDir.getFiles(function (f) {
      if (f instanceof Folder) return false;
      var name = f.name.toLowerCase();
      return name.indexOf(".otf") >= 0 || name.indexOf(".ttf") >= 0;
    });

    var fonts = [];
    for (var i = 0; i < fontFiles.length; i++) {
      var f = fontFiles[i];
      var baseName = f.name.replace(/\.[^.]+$/, "");  // uzantıyı kaldır

      // SFPRODISPLAYBOLD → SF Pro Display Bold
      var readable = baseName
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

      // Ağırlık ve stil tespiti
      var lower   = baseName.toLowerCase();
      var weight  = "Regular";
      var style   = "normal";

      if (lower.indexOf("ultraligh") >= 0 || lower.indexOf("ultralt") >= 0) weight = "UltraLight";
      else if (lower.indexOf("thin") >= 0)        weight = "Thin";
      else if (lower.indexOf("light") >= 0)       weight = "Light";
      else if (lower.indexOf("medium") >= 0)      weight = "Medium";
      else if (lower.indexOf("semibold") >= 0)    weight = "SemiBold";
      else if (lower.indexOf("heavy") >= 0)       weight = "Heavy";
      else if (lower.indexOf("black") >= 0)       weight = "Black";
      else if (lower.indexOf("bold") >= 0)        weight = "Bold";

      if (lower.indexOf("italic") >= 0)  style = "italic";

      fonts.push({
        file   : f.fsName,
        name   : readable,
        weight : weight,
        style  : style
      });
    }

    // Ağırlık sırasına göre sırala
    var weightOrder = ["UltraLight","Thin","Light","Regular","Medium","SemiBold","Bold","Heavy","Black"];
    fonts.sort(function (a, b) {
      var ai = 0, bi = 0;
      for (var w = 0; w < weightOrder.length; w++) {
        if (a.weight === weightOrder[w]) ai = w;
        if (b.weight === weightOrder[w]) bi = w;
      }
      if (ai !== bi) return ai - bi;
      if (a.style === "normal" && b.style === "italic") return -1;
      if (a.style === "italic" && b.style === "normal") return 1;
      return 0;
    });

    return JSON.stringify({ success: true, fonts: fonts });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/* ══════════════════════════════════════════════════════════════════
   Yardımcı Fonksiyonlar
   ══════════════════════════════════════════════════════════════════ */

function _hexToArray(hex) {
  hex = hex.replace("#", "");
  return [
    parseInt(hex.substring(0, 2), 16),
    parseInt(hex.substring(2, 4), 16),
    parseInt(hex.substring(4, 6), 16),
    255
  ];
}

function _hexToFloatArray(hex) {
  var arr = _hexToArray(hex);
  return [arr[0] / 255, arr[1] / 255, arr[2] / 255, 1.0];
}
