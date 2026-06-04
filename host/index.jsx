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
                                               .replace(/\t/g, "\\t")
                                               .replace(/\b/g, "\\b")
                                               .replace(/\f/g, "\\f") + '"';
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
      return JSON.stringify({
        success: false,
        error  : "Klip seçili aralıkla örtüşmüyor — klip: " + clipStart.toFixed(2) + "–" + clipEnd.toFixed(2) +
                 "s, istenen: " + rStart.toFixed(2) + "–" + rEnd.toFixed(2) +
                 "s. (In/Out aralığını kontrol edin ya da Ayarlar'dan 'Sadece In/Out aralığı'nı kapatın.)"
      });
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
  if (typeof val === "object") {
    if (val.seconds !== undefined) return parseFloat(val.seconds);
    if (val.ticks   !== undefined) return parseFloat(val.ticks) / 254016000000;
  }
  var n = parseFloat(val);
  if (isNaN(n)) return 0;
  // Heuristik: getInPoint/getOutPoint/seq.end bazı Premiere sürümlerinde ticks (string)
  // döndürür. 1e7 saniye = ~115 gün; bu kadar büyük değer saniye olamaz → ticks'tir.
  if (n > 1e7) return n / 254016000000;
  return n;
}

function _findPrimaryClip(seq, rStart, rEnd) {
  // Önce: istenen aralıkla ÖRTÜŞEN seçili klip
  var sel = _firstSelectedClip(seq, rStart, rEnd);
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

function _firstSelectedClip(seq, rStart, rEnd) {
  function overlaps(cl) {
    if (rStart === undefined || rEnd === undefined) return true;
    var s = _toSeconds(cl.start), e = _toSeconds(cl.end);
    return s < rEnd && e > rStart;
  }
  function scan(tracks) {
    for (var t = 0; t < tracks.numTracks; t++) {
      var tr = tracks[t];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var cl = tr.clips[c];
        try {
          if (cl.isSelected && cl.isSelected() && cl.projectItem && overlaps(cl)) return cl;
        } catch (e) {}
      }
    }
    return null;
  }
  return scan(seq.videoTracks) || scan(seq.audioTracks);
}

/* ══════════════════════════════════════════════════════════════════
   2b. getTimelineAudioSegments() — In/Out aralığındaki TÜM konuşma klipleri
   Timeline parçalara bölünmüş olsa bile aralığın tamamını kapsar.
   ══════════════════════════════════════════════════════════════════ */

function getTimelineAudioSegments(scope) {
  try {
    // Geriye dönük uyumluluk: eski boolean/string parametre → scope
    if (scope === true || scope === "true" || scope === "1") scope = "inout";
    if (scope === false || scope === "false" || scope === "0" || !scope) scope = "full";

    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "Aktif sekans bulunamadı." });

    var rStart, rEnd, mode = scope;
    if (scope === "inout") {
      var inS  = _toSeconds(seq.getInPoint());
      var outS = _toSeconds(seq.getOutPoint());
      if (!((outS > inS) && (outS > 0))) {
        return JSON.stringify({ success: false, error: "Timeline'da geçerli In/Out aralığı yok. I ve O ile aralık işaretleyin." });
      }
      rStart = inS; rEnd = outS;
    } else if (scope === "selected") {
      var rng = _selectedClipsRange(seq);
      if (!rng) return JSON.stringify({ success: false, error: "Seçili klip yok. Timeline'da en az bir klip seçin." });
      rStart = rng.start; rEnd = rng.end;
    } else {
      rStart = 0; rEnd = _toSeconds(seq.end);
    }
    if (rEnd <= rStart) return JSON.stringify({ success: false, error: "Geçerli bir aralık hesaplanamadı." });

    var trackIdx = _audioTrackForRange(seq, rStart, rEnd);
    if (trackIdx < 0) {
      return JSON.stringify({ success: false, error: "Seçili aralıkta ses klibi bulunamadı." });
    }

    var track = seq.audioTracks[trackIdx];
    var segs = [];
    for (var c = 0; c < track.clips.numItems; c++) {
      var cl = track.clips[c];
      var s = _toSeconds(cl.start), e = _toSeconds(cl.end);
      if (s < rEnd && e > rStart && cl.projectItem) {
        var path = "";
        try { if (cl.projectItem.getMediaPath) path = cl.projectItem.getMediaPath(); } catch (e2) { path = ""; }
        if (!path) continue;
        var clipIn = _toSeconds(cl.inPoint);
        var rs = Math.max(rStart, s), re = Math.min(rEnd, e);
        if (re <= rs) continue;
        segs.push({
          path    : path,
          srcStart: clipIn + (rs - s),
          duration: re - rs,
          tlStart : rs
        });
      }
    }
    if (!segs.length) return JSON.stringify({ success: false, error: "Seçili aralıkta okunabilir ses klibi bulunamadı." });

    segs.sort(function (a, b) { return a.tlStart - b.tlStart; });

    return JSON.stringify({
      success   : true,
      mode      : mode,
      rangeStart: rStart,
      rangeEnd  : rEnd,
      trackName : (track.name ? track.name : ("A" + (trackIdx + 1))),
      segments  : segs
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/** Aralık için hedef ses kanalı: önce seçili ses klibinin kanalı, yoksa aralıkta klibi olan ilk kanal. */
function _audioTrackForRange(seq, rStart, rEnd) {
  // 1) Kullanıcının seçtiği ses klibinin kanalı
  for (var t = 0; t < seq.audioTracks.numTracks; t++) {
    var tr = seq.audioTracks[t];
    for (var c = 0; c < tr.clips.numItems; c++) {
      var cl = tr.clips[c];
      try {
        if (cl.isSelected && cl.isSelected() && cl.projectItem) {
          var s = _toSeconds(cl.start), e = _toSeconds(cl.end);
          if (s < rEnd && e > rStart) return t;
        }
      } catch (e2) {}
    }
  }
  // 2) Aralıkta klibi olan ilk (en alttaki, A1) ses kanalı — konuşma genelde A1
  for (var t2 = 0; t2 < seq.audioTracks.numTracks; t2++) {
    var tr2 = seq.audioTracks[t2];
    for (var c2 = 0; c2 < tr2.clips.numItems; c2++) {
      var cl2 = tr2.clips[c2];
      var s2 = _toSeconds(cl2.start), e2 = _toSeconds(cl2.end);
      if (s2 < rEnd && e2 > rStart && cl2.projectItem) return t2;
    }
  }
  return -1;
}

/** Seçili tüm kliplerin kapsadığı zaman aralığı (video+audio). */
function _selectedClipsRange(seq) {
  var s = null, e = null;
  function scan(tracks) {
    for (var t = 0; t < tracks.numTracks; t++) {
      var tr = tracks[t];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var cl = tr.clips[c];
        try {
          if (cl.isSelected && cl.isSelected()) {
            var a = _toSeconds(cl.start), b = _toSeconds(cl.end);
            if (s === null || a < s) s = a;
            if (e === null || b > e) e = b;
          }
        } catch (x) {}
      }
    }
  }
  scan(seq.videoTracks);
  scan(seq.audioTracks);
  if (s === null) return null;
  return { start: s, end: e };
}

/* ══════════════════════════════════════════════════════════════════
   2c. getSequenceOverview() — Mini-timeline çizimi için sekans verisi
   ══════════════════════════════════════════════════════════════════ */

function getSequenceOverview() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "Aktif sekans bulunamadı." });

    var dur  = _toSeconds(seq.end);
    var inS  = _toSeconds(seq.getInPoint());
    var outS = _toSeconds(seq.getOutPoint());
    var hasInOut = (outS > inS && outS > 0);

    var playhead = 0;
    try { playhead = _toSeconds(seq.getPlayerPosition()); } catch (e) {}

    var tracks = [];
    function gather(trackList, type) {
      for (var t = 0; t < trackList.numTracks; t++) {
        var tr = trackList[t];
        var clips = [];
        for (var c = 0; c < tr.clips.numItems; c++) {
          var cl = tr.clips[c];
          var sel = false;
          try { sel = !!(cl.isSelected && cl.isSelected()); } catch (e2) {}
          clips.push({ start: _toSeconds(cl.start), end: _toSeconds(cl.end), selected: sel });
        }
        tracks.push({ type: type, index: t, clips: clips });
      }
    }
    gather(seq.videoTracks, "V");
    gather(seq.audioTracks, "A");

    var sel = _selectedClipsRange(seq);

    return JSON.stringify({
      success     : true,
      name        : seq.name,
      duration    : dur,
      hasInOut    : hasInOut,
      inPoint     : hasInOut ? inS  : 0,
      outPoint    : hasInOut ? outS : 0,
      playhead    : playhead,
      hasSelection: !!sel,
      selStart    : sel ? sel.start : 0,
      selEnd      : sel ? sel.end   : 0,
      tracks      : tracks
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
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
    app.userInputDisabled = true;

    var ranges = JSON.parse(rangesJSON);
    var doRipple = (ripple === undefined || ripple === "true" || ripple === true);

    if (!ranges || ranges.length === 0) {
      app.userInputDisabled = false;
      return JSON.stringify({ success: true, deletedCount: 0 });
    }

    var seq = app.project.activeSequence;
    if (!seq) {
      app.userInputDisabled = false;
      return JSON.stringify({ success: false, error: "Aktif sekans bulunamadı." });
    }

    if (typeof qe === "undefined") {
      try { app.enableQE(); } catch (e) {}
    }
    if (typeof qe === "undefined") {
      app.userInputDisabled = false;
      return JSON.stringify({ success: false, error: "QE DOM etkinleştirilemedi." });
    }

    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) {
      app.userInputDisabled = false;
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

    app.userInputDisabled = false;
    return JSON.stringify({ success: true, deletedCount: deletedCount });

  } catch (e) {
    try { app.userInputDisabled = false; } catch (e2) {}
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

    var srtResult = _writeSRT(segments, "rastflow_altyazi_");
    if (!srtResult || !srtResult.fsName) {
      return JSON.stringify({ success: false, error: "SRT dosyası yazılamadı." });
    }

    var importedToProject = false;
    try {
      app.project.importFiles([srtResult.fsName], true, app.project.rootItem, false);
      importedToProject = true;
    } catch (importErr) {}

    return JSON.stringify({
      success          : true,
      srtPath          : srtResult.fsName,
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
   5b. createCaptionTrackFromSegments() — Native Caption Track
   SRT üret → projeye aktar → timeline'a caption track olarak yerleştir
   ══════════════════════════════════════════════════════════════════ */

function createCaptionTrackFromSegments(segmentsJSON) {
  try {
    var segments = JSON.parse(segmentsJSON);
    if (!segments || segments.length === 0) {
      return JSON.stringify({ success: false, error: "Segment verisi boş." });
    }

    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "Aktif sekans bulunamadı." });

    // 1) SRT dosyasını yaz
    var written = _writeSRT(segments, "rastflow_captions_");
    var fsName  = written.fsName;

    // 2) Caption öğesi olarak projeye aktar
    var captionItem = null;
    try {
      app.project.importFiles([fsName], true, app.project.rootItem, false);
      captionItem = _findImportedItem(written.baseName);
    } catch (impErr) {
      return JSON.stringify({ success: false, error: "SRT içe aktarılamadı: " + impErr.message, srtPath: fsName });
    }

    if (!captionItem) {
      return JSON.stringify({
        success: true, placedOnTimeline: false, srtPath: fsName, segmentCount: segments.length,
        note: "SRT projeye aktarıldı ama öğe bulunamadı — Proje panelinden caption track'e sürükleyin."
      });
    }

    // 3) Timeline'a caption track olarak yerleştir (best-effort, çoklu deneme)
    app.userInputDisabled = true;
    var placed = false;
    var tObj = new Time(); tObj.seconds = 0;

    var attempts = [
      function () { seq.insertClip(captionItem, tObj, 0, 0); },
      function () { seq.insertClip(captionItem, tObj); },
      function () { seq.overwriteClip(captionItem, tObj); },
      function () { seq.overwriteClip(captionItem, "0"); }
    ];
    for (var ai = 0; ai < attempts.length && !placed; ai++) {
      try { attempts[ai](); placed = true; } catch (eAtt) {}
    }
    app.userInputDisabled = false;

    return JSON.stringify({
      success         : true,
      placedOnTimeline: placed,
      srtPath         : fsName,
      segmentCount    : segments.length,
      note            : placed ? "" : "Otomatik yerleştirme bu Premiere sürümünde çalışmadı — SRT Proje panelinde, caption track'e sürükleyin."
    });

  } catch (e) {
    try { app.userInputDisabled = false; } catch (e2) {}
    return JSON.stringify({ success: false, error: e.message });
  }
}

/** SRT içeriğini üretip dosyaya yazar (proje klasörü, olmazsa temp). */
function _writeSRT(segments, prefix) {
  var srtContent = "";
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    srtContent += (i + 1) + "\r\n";
    srtContent += _secsToSRTTime(parseFloat(seg.start)) + " --> " + _secsToSRTTime(parseFloat(seg.end)) + "\r\n";
    srtContent += (seg.text || "") + "\r\n\r\n";
  }

  var baseName = prefix + new Date().getTime() + ".srt";
  var srtPath  = Folder.temp.absoluteURI + "/" + baseName;
  try {
    var projFile = app.project.path;
    if (projFile && projFile.length > 0) {
      srtPath = new File(projFile).parent.absoluteURI + "/" + baseName;
    }
  } catch (e) {}

  var srtFile = new File(srtPath);
  srtFile.encoding = "UTF-8";
  if (!srtFile.open("w")) {
    srtFile = new File(Folder.temp.absoluteURI + "/" + baseName);
    srtFile.encoding = "UTF-8";
    if (!srtFile.open("w")) {
      throw new Error("SRT dosyası yazılamadı: İzin reddedildi.");
    }
  }
  srtFile.write(srtContent);
  srtFile.close();

  return { file: srtFile, baseName: baseName, fsName: srtFile.fsName };
}

/** İçe aktarılan SRT öğesini proje kökünde isimden bulur (uzantı strip edilmiş olabilir). */
function _findImportedItem(baseName) {
  try {
    var root = app.project.rootItem;
    var nameNoExt = baseName.replace(/\.[^.]+$/, "");
    for (var i = root.children.numItems - 1; i >= 0; i--) {
      var it = root.children[i];
      try {
        if (it && it.name && (it.name === baseName || it.name === nameNoExt || it.name.indexOf(nameNoExt) >= 0)) {
          return it;
        }
      } catch (e) {}
    }
  } catch (e2) {}
  return null;
}

/* ══════════════════════════════════════════════════════════════════
   6. createSubtitleGraphicClips() — Essential Graphics Enjeksiyon Motoru
   ══════════════════════════════════════════════════════════════════ */

function createSubtitleGraphicClips(segmentsJSON, styleParamsJSON) {
  try {
    app.userInputDisabled = true;

    var segments    = JSON.parse(segmentsJSON);
    var styleParams = JSON.parse(styleParamsJSON);

    if (!segments || segments.length === 0) {
      app.userInputDisabled = false;
      return JSON.stringify({ success: false, error: "Segment verisi boş." });
    }

    var seq = app.project.activeSequence;
    if (!seq) {
      app.userInputDisabled = false;
      return JSON.stringify({ success: false, error: "Aktif sekans bulunamadı." });
    }

    var trackIndex  = (styleParams.trackIndex !== undefined) ? styleParams.trackIndex : 1;
    var videoTrack  = seq.videoTracks[trackIndex];
    if (!videoTrack) {
      app.userInputDisabled = false;
      return JSON.stringify({ success: false, error: "Video track " + trackIndex + " bulunamadı." });
    }

    var ticksPerSec  = 254016000000;
    var createdCount = 0;

    for (var i = 0; i < segments.length; i++) {
      var seg        = segments[i];
      var startSec   = parseFloat(seg.start);
      var endSec     = parseFloat(seg.end);
      var startTicks = Math.round(startSec * ticksPerSec);
      var durTicks   = Math.round((endSec - startSec) * ticksPerSec);

      if (durTicks <= 0) continue;

      try {
        var startTime = new Time();
        startTime.ticks = String(startTicks);

        var graphicClip = videoTrack.createGraphicClip(startTime);
        if (!graphicClip) continue;

        var endTime = new Time();
        endTime.ticks = String(startTicks + durTicks);
        graphicClip.end = endTime;

        // Metin içeriği — mevcut text item varsa güncelle, yoksa ekle
        try {
          var comp = graphicClip.getMOGRTComponent
            ? graphicClip.getMOGRTComponent()
            : null;

          if (comp && comp.properties && comp.properties.firstObject) {
            var textProp = comp.properties.firstObject;
            var textDoc  = textProp.getValue();

            textDoc.font          = styleParams.fontName  || "Arial";
            textDoc.fontSize      = styleParams.fontSize  || 48;
            textDoc.fillColor     = _hexToFloatArray(styleParams.textColor || "#FFFFFF");
            textDoc.justification = (styleParams.alignment === "right") ? 2
                                  : (styleParams.alignment === "left")  ? 0
                                  : 1; // center

            if (styleParams.backgroundEnabled) {
              textDoc.backgroundEnabled = true;
              textDoc.backgroundColor   = _hexToFloatArray(styleParams.backgroundColor || "#000000");
              textDoc.backgroundOpacity = (styleParams.backgroundOpacity || 75) / 100;
            } else {
              textDoc.backgroundEnabled = false;
            }

            textDoc.text = seg.text || "";
            textProp.setValue(textDoc);
          }
        } catch (textErr) { /* TextDocument API mevcut değilse sessizce devam et */ }

        // Dynamic mod: Pop-in ölçek keyframe'leri
        if (styleParams.mode === "dynamic" && seg.words && seg.words.length > 0) {
          try {
            var motionProp = graphicClip.getComponentParam("Motion", "Scale");
            if (motionProp) {
              for (var w = 0; w < seg.words.length; w++) {
                var wrd     = seg.words[w];
                var wTicks  = Math.round(parseFloat(wrd.start) * ticksPerSec);
                var wTicks2 = Math.round((parseFloat(wrd.start) + 0.06) * ticksPerSec);
                motionProp.addKeyframe(wTicks,  100);
                motionProp.addKeyframe(wTicks2, 115);
              }
            }
          } catch (kfErr) {}
        }

        createdCount++;
      } catch (clipErr) {}
    }

    app.userInputDisabled = false;
    return JSON.stringify({ success: true, createdCount: createdCount });

  } catch (e) {
    try { app.userInputDisabled = false; } catch (e2) {}
    return JSON.stringify({ success: false, error: e.message });
  }
}

/* ══════════════════════════════════════════════════════════════════
   7. addKeyframesToLayer() — Genel Keyframe API
   ══════════════════════════════════════════════════════════════════ */

function addKeyframesToLayer(paramsJSON) {
  try {
    var p    = JSON.parse(paramsJSON);
    var seq  = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "Aktif sekans yok." });
    var track = seq.videoTracks[p.trackIndex];
    if (!track) return JSON.stringify({ success: false, error: "Track yok." });
    var clip  = track.clips[p.clipIndex];
    if (!clip) return JSON.stringify({ success: false, error: "Klip yok." });

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
