# Claude Prompts for Rast Flow AI Development

Use these prompts one by one in your next session with Claude. They are fully compiled and updated to include the **Direct Timeline Subtitle Injection Engine (Essential Graphics)**, styling panel, dynamic keyframe animation highlights, `Alt + Z` undo, FFmpeg input seeking, and visual card rendering.

````carousel
```markdown
[PROMPT 1] — Bütünleşik Altyazı Kartları Görünümü & Detaylı Stil Paneli (index.html, style.css, app.js)

Rast Flow AI projemizde, Transkript sekmesini Altyazı sekmesiyle daha bütünleşik çalışacak şekilde güncelleyeceğiz. Transkript alanındaki düz kelime akışı yerine, kelimeleri otomatik olarak kendi altyazı kartlarında (Subtitle Cards/Blocks) gruplayarak göstereceğiz. Ayrıca altyazı panelinde gelişmiş Essential Graphics tasarım kontrollerini ekleyeceğiz.

Lütfen mevcut kod yapısını (özellikle TranscriptEditor.render, SubtitleEngine ve UIController modüllerini) bozmadan şu değişiklikleri yap:

1. UI & Layout Güncellemeleri (index.html & style.css):
- Transkript alanında her bir altyazı segmentini `.subtitle-card` sınıfına sahip görsel bir kutu (kart) olarak render et.
- Kartın sol üstünde o segmentin başlangıç süresini (Örn: 00:12), sağ üstünde ise o segmentteki toplam karakter sayısını (char count) göster. Karakter sayısı 42'yi aşarsa sayacı hafif kırmızı renkle uyar.
- Altyazı paneline şu ek kontrolleri yerleştir:
  * "Altyazı Tarzı" Dropdown menüsü: "Kurumsal / Sade" ve "Dinamik / Animasyonlu" seçenekleri.
  * "Arka Plan Metin Kutusu (Box)" Toggle/Switch butonu. Bu buton aktif olduğunda alt tarafta "Kutu Rengi" (Color Picker) ve "Opaklık" (%0 - %100 Slider) kontrol alanları görünür (display: block) olsun.
  * "Pasif Kelime Rengi" (Color Picker) - Aktif olmayan kelimeler için.
  * "Büyük/Küçük Harf (ALL CAPS)" Toggle butonu.
- Arayüzdeki bu yeni ayar durumlarını localStorage üzerinde kalıcı olarak tut.

2. JS & Performans Güncellemeleri (app.js):
- TranscriptEditor.render fonksiyonunu, TranscriptStore'dan gelen segment breaks bilgilerine göre kelimeleri kart gruplarına ayıracak şekilde yeniden yaz.
- Bir kelimeye çift tıklandığında düzenleme (edit) modu kartın içinde çalışmaya devam etsin.
- Aktif oynatılan kelimenin bulunduğu kart otomatik olarak `.active-card` sınıfını alsın ve ekranda o karta scroll yapılsın.
- DOM Performans Optimizasyonu: Kelimelerin durum değişikliklerinde (filler, delete, playing vb.) tüm transkript alanını baştan çizmek (`innerHTML = ''`) yerine, sadece ilgili kelimenin `span` veya kart elemanını hedef alarak sınıfını değiştir (`element.classList.toggle`).
```
<!-- slide -->
```markdown
[PROMPT 2] — Repeat (Tekrar) Sekmesi, Alt+Z Undo & Whisper Chunking (index.html, app.js, style.css)

Rast Flow AI projemize ayrı bir "Tekrarlar" (Repeats) sekmesi/paneli eklemek, "Alt + Z" ile çakışmasız geri alma (Undo) motoru kurmak ve büyük dosyalar için otomatik parçalama eklemek istiyoruz.

Lütfen kod üzerinde şu geliştirmeleri yap:

1. UI Güncellemesi (index.html & style.css):
- Tab bar'a "Tekrarlar" isminde yeni bir sekme ekle ve bunun için `panelRepeat` id'li bir panel oluştur.
- Bu panelde "Tekrarları Tara" butonu ve altında tespit edilen tekrarları listeyle gösterecek bir `.repeat-list` alanı tasarla.

2. Tekrar Avcısı & Otomatik İşaretleyici (app.js - SilenceRemover & UIController):
- `findRepeats` fonksiyonunu sadece ardışık kelimeler için değil, 2 ila 3 kelimelik öbek tekrarlarını da (Örn: "şöyle ki... şöyle ki...") bulacak şekilde geliştir.
- Otomatik İşaretleyici: Taramadan hemen sonra, tespit edilen tüm tekrarlayan ilk kelimeleri otomatik olarak silinecekler (deleted = true) listesine ekle.
- Tespit edilen her tekrar grubu için bir kart oluştur. Kartta tekrar eden kelime/ifade, süresi, bir "Dinle" butonu (playhead'i o kelimeye götürür) ve bir "Koru" (işareti kaldır/silme) butonu olsun.

3. Alt + Z Geri Alma (Undo) Motoru (app.js):
- Eklenti genelinde yanlışlıkla silinen kelimeleri veya sessizlikleri geri almak için bir Undo (Geri Al) geçmişi tasarla (son 10 işlemi hafızada tutsun).
- Premiere Pro'nun kendi `Ctrl + Z` geçmişiyle çakışmaması için, geri alma fonksiyonunu klavyeden **`Alt + Z`** kısayoluna bağla.

4. Büyük Dosyalar İçin Whisper Otomatik Parçalama (app.js):
- `APIManager.transcribe` işleminde, çıkarılan WAV dosyasının süresi 15 dakikayı aşıyorsa, dosyayı FFmpeg kullanarak otomatik olarak 10 dakikalık parçalara (chunks) böl.
- This parçaları sırayla veya paralel olarak Whisper API'ye gönder, dönen kelime dizilerindeki zaman damgalarını (offset ekleyerek) birleştirip tek bir kelime dizisi halinde döndür.
```
<!-- slide -->
```markdown
[PROMPT 3] — Timeline Canlı Altyazı Enjeksiyon Motoru & Essential Graphics (index.jsx, app.js)

Rast Flow AI projemizde, altyazıları harici bir SRT olarak üretmek yerine doğrudan Premiere Pro Timeline'ına canlı **Essential Graphics (Text Track) klipleri** olarak işleyecek enjeksiyon motorunu oluşturmak istiyoruz.

Lütfen mevcut index.jsx (ExtendScript) ve app.js (SubtitleEngine) dosyalarını şu standartlara göre revize et:

1. index.jsx (ExtendScript) Canlı Enjeksiyon Metotları:
- `createSubtitleGraphicClips(segmentsJSON, styleParamsJSON)` adında bir fonksiyon yaz.
- `segmentsJSON` verisindeki her bir cümle öbeği/segment için belirlenen trackIndex (Örn: Video 2 veya Video 3) üzerinde `videoTrack.createGraphicClip(startTime)` metodunu kullanarak canlı bir grafik klibi oluştur. Bu klibin süresini segmentin `end - start` değerine ayarla.
- Grafik klibi içerisindeki varsayılan metin katmanını bul veya `graphicClip.addTextItem(text)` ile yeni bir metin alanı oluştur.
- Seçilen yerel font adını ve boyutunu `TextDocument` nesnesini manipüle ederek uygula:
  ```javascript
  var mogrt = graphicClip.getMOGRTComponent();
  var textProp = mogrt.properties.firstObject;
  var textDoc = textProp.getValue();
  textDoc.font = styleParams.fontName;
  textDoc.fontSize = styleParams.fontSize;
  textDoc.fillColor = _hexToFloatArray(styleParams.textColor);
  textDoc.justification = styleParams.alignment; // 0: Left, 1: Center, 2: Right
  
  // Arka Plan Kutusu (Box) Özellikleri:
  if (styleParams.backgroundEnabled) {
    textDoc.backgroundEnabled = true;
    textDoc.backgroundColor = _hexToFloatArray(styleParams.backgroundColor);
    textDoc.backgroundOpacity = styleParams.backgroundOpacity; // 0.0 - 1.0 arası float
  } else {
    textDoc.backgroundEnabled = false;
  }
  textProp.setValue(textDoc);
  ```

2. Koşullu Kelime Animasyonu & Keyframe Motoru (app.js - SubtitleEngine):
- Arayüzden gelen "Altyazı Tarzı" ayarını oku.
- **Kurumsal / Sade Mod:** Kelime kelime bölmek yerine, kelimeleri anlamlı cümle öbekleri (satır başına maks 7-8 kelime) halinde birleştir, arka plan kutusuyla birlikte sabit (animasyonsuz) ve tek renk olarak timeline'a yerleştir.
- **Dinamik / Animasyonlu Mod:** Her bir kelimenin konuşulduğu süreleri (Word-level timestamps) oku. Metindeki kelimeleri animasyonlu göstermek için, ilgili grafik klibinin Essential Graphics `Source Text` özelliğine veya Scale/Position parametrelerine keyframe ekle. Konuşmacı tam o kelimeyi söylerken o kelimenin rengini vurgu rengine (Örn: Sarı/Yeşil) boyayacak, bir önceki ve sonraki kelimeleri mat tutacak `TextDocument` değişim anahtar karelerini (keyframes) `addKeyframesToLayer` mekanizması ile enjekte et veya kelime bazlı "Pop-in" ölçeklendirme keyframe'leri üret.
```
<!-- slide -->
```markdown
[PROMPT 4] — Akıllı SRT Bölme Motoru, FFmpeg Hızlandırma & Arayüz Kilitleme (app.js, index.html, index.jsx)

Rast Flow AI projemizde, altyazıların otomatik bölünmesini sağlayan bir akıllı motor, manuel Split/Merge arayüzü ve FFmpeg ile Premiere işlemlerini hızlandıracak performans optimizasyonlarını entegre etmek istiyoruz.

Lütfen şu geliştirmeleri yap:

1. Otomatik SRT Bölme Algoritması (app.js - SubtitleEngine):
- `autoSegmentSubtitles(maxChars = 35, maxDuration = 3.0, silenceThreshold = 0.5)` fonksiyonunu ekle.
- Bu fonksiyon: Noktalama işaretlerine (. , ? ! -), kelimeler arasındaki desibel/zaman boşluklarına, satır karakter limitine ve gösterim süresine bakarak otomatik bölme noktaları (segment breaks) hesaplasın ve bunları TranscriptStore'a kaydetsin.
- Transkript sekmesinin en üstündeki araç çubuğuna "🪄 Otomatik Böl" butonu ekle ve bu motoru tetikle.
- Manuel Split & Merge: Her altyazı kartının (subtitle-card) arasına ince interaktif bölme çizgisi koy. Çizgide bir "Birleştir" (Merge) butonu olsun; tıklandığında aradaki segment break'i kaldırsın. Her kelimeye sağ tıklandığında veya üzerine gelindiğinde "Buradan Böl" (Split) seçeneği sunulsun.

2. FFmpeg Hızlandırması (app.js - APIManager):
- `_extractAudio` fonksiyonunda kullanılan FFmpeg komut diziliminde `-ss` (seek) parametresini mutlaka `-i` parametresinden **örce** yaz (Input Seeking). Bu sayede uzun videolarda ses çıkarma hızı 10 kat artacaktır.

3. Premiere Arayüz Kilitleme (index.jsx):
- `rippleDeleteRanges` ve `createSubtitleGraphicClips` fonksiyonları çalışırken Premiere Pro arayüzünün gereksiz çizim yapıp donmasını engellemek için işlem döngülerinin en başına `app.userInputDisabled = true;` satırını ekle. İşlemler bittiğinde ve başarıyla tamamlandığında `app.userInputDisabled = false;` ile arayüz kilidini kaldır.
```
````
