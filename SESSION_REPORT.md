# Rast Flow AI — Oturum Raporu

> Bu rapor, bir geliştirme oturumunda Rast Flow AI Premiere Pro CEP eklentisi
> üzerinde konuşulan ve yapılan her şeyi özetler. Yeni bir oturumda bağlamı
> hızlıca aktarmak için hazırlanmıştır.

---

## 1. Proje Nedir?

**Rast Flow AI**, Adobe Premiere Pro için bir **CEP eklentisidir** (panel).
AI destekli video kurgu akışı sunar:

- **Transkript**: Klibin sesini çıkarıp Whisper ile kelime-zamanlı transkript üretir.
- **Kurgu**: Sessizlik / dolgu (filler) / tekrar tespiti ve timeline'dan ripple-delete ile kesim.
- **Altyazı**: Transkriptten altyazı segmentleri; SRT veya MOGRT (animasyonlu graphic) çıktısı.
- **AI Editör**: AI ile transkript temizleme (kekeme/dolgu/yanlış çekim eleme) ve düzeltme.

**Teknoloji yığını:** CEP (Chromium tabanlı panel + Node.js entegrasyonu),
ExtendScript (Premiere host tarafı), FFmpeg / WebAudio (ses çıkarma), OpenAI/Groq Whisper API.

---

## 2. Mimari ve Dosya Yapısı

| Dosya | İçerik |
|---|---|
| `client/app.js` | Ana JS. Modüller: **APIManager** (transkript motorları, anahtar şifreleme, ses birleştirme), **TranscriptStore** (kelime/segment veri + undo), **TranscriptEditor** (DOM editör, sürükle-bırak, sağ-tık), **SilenceRemover** (sessizlik/tekrar/filler), **AIEditorEngine** (AI düzeltme/temizleme), **SubtitleEngine** (altyazı/MOGRT/SRT), **UIController** (UI yönetimi) |
| `client/index.html` | Panel arayüzü (Transkript / Kurgu / Altyazı / AI Editör sekmeleri + Ayarlar çekmecesi) |
| `client/style.css` | Stiller |
| `host/index.jsx` | **ExtendScript** — Premiere ile tüm etkileşim (ses kaynağı, ripple delete, MOGRT/caption enjeksiyonu, sekans bilgisi) |
| `CSXS/manifest.xml` | CEP manifest (`--enable-nodejs`, `--mixed-context`, `--disable-web-security`) |
| `templates/caption.mogrt` | Animasyonlu altyazı şablonu (kullanıcı tarafından Premiere'de oluşturuldu) |
| `lib/ffmpeg/` | Opsiyonel ffmpeg.exe (yoksa WebAudio'ya düşer) |
| `fonts/` | Yerel SF Pro fontları |

**GitHub:** https://github.com/bewoai/rast-flow-ai (`main` dalı)

---

## 3. Kurulum / Çalışma Düzeni — ÖNEMLİ

İki ayrı konum var:
- **DEV (geliştirme + git repo):** `C:\Users\pc\Desktop\com.pr.workflow`
- **RUN (Premiere'in yüklediği):** `%APPDATA%\Adobe\CEP\extensions\com.pr.workflow`

> ✅ **RUN artık DEV'e bir Junction** (`mklink /J` türü). Yani DEV'deki her kod
> değişikliği **anında canlı**; sadece panel reload (kapat-aç) gerekir, manuel
> kopyalama YOK. (Başlangıçta ayrı kopyalardı ve senkron kalmıyordu — bu oturumda
> junction'a çevrildi.)

Junction'ı yeniden kurma (Premiere KAPALIYKEN):
```powershell
$r="$env:APPDATA\Adobe\CEP\extensions\com.pr.workflow"; Remove-Item $r -Recurse -Force; New-Item -ItemType Junction -Path $r -Target "C:\Users\pc\Desktop\com.pr.workflow"
```

---

## 4. Bu Oturumda Yapılanlar (özellik bazlı)

### 4.1. Transkript Omurgası — Çoklu Klip Ses (KRİTİK DÜZELTME)
- **Sorun:** In/Out aralığı ~1.5 dk olmasına rağmen sadece 7 kelime çıkıyordu.
  Kök neden: eski kod aralıktaki **tek bir klibi** bulup süreyi ona kısaltıyordu;
  timeline jump-cut'larla parçalıyken sadece ilk klibin ~4 sn'si çıkıyordu.
- **Çözüm:** `getTimelineAudioSegments(scope)` (JSX) aralıktaki **tüm konuşma kliplerini**
  toplar. Ses, **boşluklar sessizlikle korunarak** birleştirilir (FFmpeg, yoksa
  **WebAudio çoklu-klip birleştirici** — `_buildTimelineWavWebAudio` / `_resampleSegment`).
  Böylece kelime zaman damgaları timeline ile birebir hizalı kalır.
- **Ek:** `_toSeconds` artık ticks/saniye ayırt eder (Premiere API tutarsızlığı);
  klip seçimi sadece istenen aralıkla örtüşen seçili klibi kullanır.

### 4.2. Transkript Kapsam Seçici (Modal)
- "Transkript Oluştur"a basınca **mini-timeline + 3 buton** açılır: **Tüm Sekans / In-Out / Seçili Klipler**.
- `getSequenceOverview()` (JSX) klipleri, in/out, playhead, seçimi döndürür; client mini-timeline çizer.
- Kullanılamayan kapsam (in/out yok, seçim yok) butonu otomatik devre dışı.

### 4.3. Transkript Kelime Düzenleme
- **Sürükle-bırak** ile sıralama (zaman damgası yeniden atanır).
- **× ile sil** (transkriptten çıkar) / **+ ile ekle** / çift-tık düzenle.
- **Tam-snapshot Undo (Alt+Z)** — silme/ekleme/taşıma dahil.
- Sağ-tık ayrımı: "🗑 Transkriptten sil" vs "✂ Videodan kes".
- **Satır taşıma (son eklenen):** Sağ-tık → "⬆ Üst satıra al" / "⬇ Alt satıra al" —
  segment break'i kaydırarak tek kelimeyi caption satırları arasında taşır.

### 4.4. Türkçe Metin Araçları
- **Bul & Değiştir** (tek hamlede): sağ-tık "Tüm 'X' değiştir" + araç çubuğu çubuğu.
  Türkçe-duyarlı, noktalama korur. (Örn: tüm "pikos" → "PCOS".)
- **✨ AI Düzelt (tek tuş):** AI ile (1) Türkçe noktalama, (2) imla/büyük harf,
  (3) tıbbi/teknik terim düzeltme (smear, PCOS, MR, USG…), sonra **anlam-temelli bölme**.
  AI artık her kelimeye `br` (blok sonu) işareti döndürür → bölme karakter limitine
  değil **cümle anlamına** göre. Çok-kelimeli terim tek terime inerse birleştirir.
  Varsayılan model **gpt-4o**.
- **🪄 Otomatik Böl:** AI'sız, cümle-farkında (noktalamadan) bölme.

### 4.5. Kurgu / Kesim UX
- **Yapışkan "Premiere'e Uygula" çubuğu:** Tüm sekmelerde altta; bekleyen kesim
  sayısı/süresi canlı; tek tıkla Premiere'e uygular (eskiden Kurgu sekmesine gidip
  Kes'e basmak gerekiyordu). Uyguladıktan sonra `applied` bayrağıyla temizlenir.
- Filler/tekrar işaretleri artık gerçekten kesime giriyor; AI silmeleri **yumuşak**
  (üstü çizili, görünür, geri alınabilir).

### 4.6. Altyazı Çıktısı — Native Caption Track → MOGRT
- Önce **native caption track** denendi (SRT → importFiles → insertClip) — yerleşti ama
  animasyon/stil sınırlı.
- Sonra kullanıcı **animasyonlu graphic** isteyince **MOGRT** yaklaşımına geçildi
  (AutoCut/FireCut'ın yöntemi): `createCaptionGraphicsFromMogrt` her segment için
  `templates/caption.mogrt`'ı `importMGT` ile koyar, metnini doldurur. **Stil + animasyon
  şablonun içinde.**
- Eklenti yolu artık **client'tan** (`CSInterface.getSystemPath(EXTENSION)`) geliyor;
  ExtendScript `$.fileName` güvenilmez (Premiere kurulum dizinini veriyordu).

### 4.7. Transkript Motorları — Ücretsiz Seçenekler
- Ayarlar'da **Motor** dropdown'ı: **OpenAI / Groq (ücretsiz) / Yerel (whisper.cpp)**.
- **Groq tam çalışır:** `api.groq.com`, `whisper-large-v3`, OpenAI-uyumlu; ayrı şifreli anahtar.
  Kelime zaman damgası gelmezse segment metnini eşit dağıtan yedek.
- **Yerel (whisper.cpp):** şu an **stub** — sıradaki iş.

### 4.8. Pano Kopyalama Düzeltmesi
- CEP `file://` bağlamında `navigator.clipboard` çalışmaz → `execCommand('copy')` yedeği
  (`UIController.copyText`). Toast artık gerçekten kopyalanınca başarı der.

### 4.9. Genel Bug Temizliği + Gemini Regresyonları
- Ölü kontroller bağlandı/kaldırıldı (shadow/bounce/highlight toggle, allTracksToggle).
- Kullanıcı **Gemini** ile iki commit yapmıştı; çoğu iyileştirmeydi ama iki **regresyon** geri alındı:
  (1) şifreleme anahtarı (kayıtlı API key okunamaz olmuştu) hostname-türevliye döndürüldü,
  (2) manifest'ten silinen `--disable-web-security` geri eklendi (yerel font için).

### 4.10. Git / GitHub
- Git kimliği ayarlandı: **bewoai / beratphotoart@gmail.com**.
- **AutoCut/FireCut izleri tamamen silindi:** dosyalar + **git geçmişi yeniden yazıldı**
  (filter-branch) + **force-push**. Artık hiçbir commit'te (içerik/mesaj/dosya) iz yok.
- `findFfmpeg` export hatası düzeltildi.

---

## 5. Şu An Çalışan Özellikler
- Transkript (OpenAI + Groq), çoklu-klip aralık, kapsam seçici modal.
- Kelime düzenleme (sürükle/sil/ekle/satır-taşı/undo), Bul&Değiştir, AI Düzelt.
- Sessizlik/tekrar/filler tespiti + yapışkan çubukla tek-tık kesim.
- MOGRT klip **yerleştirme** (timeline'a kondu).
- SRT indirme.

---

## 6. Açık Sorunlar / Bekleyen İşler
1. **MOGRT metin doldurma** — klipler kondu ama metin şablonun placeholder'ında kalıyor
   ("ÖRNEK ALTYAZI STİLİMİZ BU"). `.mogrt` içi incelendi: tek param **"TextLayer"**,
   değer **TextDocument/strDB** formatında. Son düzeltme: `getMGTComponent` + `getMOGRTComponent`
   her ikisi + TextDocument(`.text`)/strDB(`.strDB[0].str`)/düz string stratejileri +
   başarısızsa tam `setValue` hatasını Günlük'e yazma. **Test edilip doğrulanması gerekiyor.**
2. **MOGRT özelleştirme** — bu şablon yalnızca metni dışa veriyor; renk/font/animasyon/konum
   şablonda sabit. Paneldeki stil kontrolleri MOGRT'a bağlı değil. Çözüm yolları: (a) şablonda
   parametre açmak, (b) çoklu şablon + "Tarz" seçimi, (c) konum/boyutu Motion'dan ayarlamak.
3. **whisper.cpp (yerel motor)** — henüz stub, kurulacak.
4. **Paneldeki stil/animasyon kontrolleri** MOGRT çıktısında işlevsiz (vestigial) — bağlanacak ya da gizlenecek.
5. **Yerel font yükleme** muhtemelen aynı `$.fileName` sorunundan etkileniyor (MOGRT yolu gibi düzeltilebilir).
6. Eski commit'ler "unknown" yazarıyla (kimlik ayarlanmadan önce) — kullanıcı düzeltmek istemedi.
7. MOGRT şablonu **1080x1920 (dikey)**, sekans yatay — ölçek/konum uyumsuzluğu olabilir.

---

## 7. Teknik Notlar / Öğrenilen Dersler
- **`$.fileName` (ExtendScript)** evalScript'le çağrılan fonksiyonlarda eklenti yolunu
  GÜVENİLMEZ verir (Premiere kurulum dizini çıkabilir). Eklenti yolunu **client'tan**
  `CSInterface.getSystemPath(SystemPath.EXTENSION)` ile alıp JSX'e geçir.
- **CEP `file://` bağlamı**: `navigator.clipboard` ve secure-context API'leri yok → `execCommand` yedeği.
- **MOGRT metni**: `clip.getMGTComponent()` (veya `getMOGRTComponent()`) → `properties` →
  metin param'ı; değer **TextDocument** (`.text`, `.font`, `.fillColor` …) ya da **strDB**.
  `.mogrt` bir ZIP; `definition.json` parametreleri (clientControls) gösterir.
- **Groq** OpenAI-uyumlu: `api.groq.com/openai/v1/audio/transcriptions`, `whisper-large-v3`.
- **DEV/RUN** ayrı kopyaysa kod değişiklikleri canlıya gitmez → **Junction** çözer.
- Premiere API `_toSeconds`: in/out/seq.end bazen **ticks**, bazen **saniye** döndürür.

---

## 8. Git Durumu (rapor anındaki)
- Son push'lanmış commit: `b54440a` "Transcription engines (Groq), MOGRT captions, AI segmentation, clipboard fix"
- **Commit edilmemiş** (lokal): `client/app.js` + `host/index.jsx` →
  satır taşıma (üst/alt satıra al) + MOGRT metin-doldurma sağlamlaştırması/teşhisi.
- Remote: `https://github.com/bewoai/rast-flow-ai.git` (main)

---

## 9. Sonraki Önerilen Adımlar
1. MOGRT metin doldurmayı test et → çalışmazsa Günlük'teki `setErr` satırını analiz et.
2. MOGRT özelleştirme yönünü seç (şablon param / çoklu şablon / Motion konum).
3. whisper.cpp yerel motorunu kur.
4. Bekleyen lokal değişiklikleri commit/push et.
