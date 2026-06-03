# Rast Flow AI — Claude Geliştirme Prompt Kılavuzu

Bu dosya, Rast Flow AI Premiere Pro CEP eklentisini geliştirmek üzere Claude (Sonnet/Opus vb.) ile yapacağınız kodlama seanslarında kopyalayıp sırayla gönderebileceğiniz **5 aşamalı prompt serisini** içerir.

---

## 🚀 0. Adım: Claude'a Başlangıç Ön Hazırlık Mesajı

Yeni bir Claude sohbeti başlatın. Eklentinin ana kodlarını (`client/index.html`, `client/style.css`, `client/app.js` ve `host/index.jsx` dosyalarını) mesaja ekleyin ve aşağıdaki mesajla birlikte gönderin:

```markdown
Merhaba, Adobe Premiere Pro için geliştirdiğimiz "Rast Flow AI" isimli bir CEP eklentisi üzerinde çalışıyorum. Bu eklentiyi geliştirmek ve yeni özellikler eklemek istiyorum. Kod tabanımı oluşturan index.html, style.css, app.js ve host/index.jsx dosyalarını sana iletiyorum. 

Benimle adım adım çalışmanı ve her adımda sadece ilgili dosyaları güncelleyerek bana tam kodları vermeni rica ediyorum. İlk adım olarak Altyazı Kartları Görünümü ve Stil Paneli ile başlayacağız. Hazırsan ilk talimatı gönderiyorum.
```

---

## 📋 [PROMPT 1] — Bütünleşik Altyazı Kartları Görünümü & Detaylı Stil Paneli

**Hedef**: Transkript kelime akışını görsel kartlara (subtitle blocks) dönüştürmek, altyazı tasarım kontrollerini zenginleştirmek ve DOM performansını optimize etmek.

```markdown
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

---

## 📋 [PROMPT 2] — sliding Puanlamalı Tekrar Avcısı, Alt+Z Geri Alma & Whisper Parçalama

**Hedef**: sliding'ın özel kayan pencere tekrar eşleme algoritmasını entegre etmek, görsel tekrar kartları oluşturmak, `Alt + Z` kısayollu Undo motorunu yazmak ve uzun sesler için Whisper dilimleme eklemek.

```markdown
Rast Flow AI projemize sliding'ın matematiksel tekrar algılama motorunu, "Alt + Z" ile çakışmasız geri alma (Undo) motorunu ve büyük dosyalar için otomatik parçalama eklemek istiyoruz.

Lütfen kod üzerinde şu geliştirmeleri yap:

1. sliding Algoritması ile Tekrar Avcısı (app.js - findRepeats):
- `findRepeats(method)` fonksiyonunu sliding'ın sliding-window (kayan pencere) sequence-matcher algoritmasına göre güncelle.
- Algoritma, kelimeleri noktalama işaretlerinden temizleyip normalleştirerek `u` (1'den 10'a kadar) uzunluğundaki kelime öbeklerinin ardışık tekrarlarını (`l` kez) taramalıdır.
- Her tekrar grubu için şu formüle göre skor hesapla: Score = u * (l - 1) - 2. Sadece Score >= 0 ve l > 1 olan tekrarları yakala.
  * (Bu formül sayesinde "bence bence" gibi 2'li kelimeler elenirken, 3'lü "bence bence bence" veya 2 kelimelik öbek tekrarları "şöyle ki şöyle ki" başarıyla yakalanır).
- Çakışmaları önlemek için bir tekrar bulunduğunda `u * l` kadar indeksi atlayarak devam et.
- İşaretleme: Tespit edilen tekrarlarda, sonuncu tekrar grubu (yani en son ve doğru söylenen cümle) hariç önceki tüm kopyaları otomatik olarak `deleted = true` ve `repeat = true` olarak işaretle.

2. Arayüz ve Kontroller (index.html & style.css & app.js):
- "Tekrar Avcısı" bölümü altına tespit edilen tekrarların listeleneceği `.repeat-list` alanı ekle.
- Tespit edilen her tekrar grubu için bir kart oluştur. Kartta tekrar eden ifade, kaç kez tekrarlandığı (Örn: "şöyle ki (x2)") ve başlangıç süresi yazmalıdır.
- Kartta bir "Dinle" butonu (Premiere playhead'ini o kelimeye götürür) ve bir "Koru" (kelimelerin silme işaretini kaldıran) butonu olsun.

3. Alt + Z Geri Alma (Undo) Motoru (app.js):
- Yanlışlıkla silinen kelimeleri geri almak için bir Undo (Geri Al) geçmişi tasarla (son 10 işlemi hafızada tutsun).
- Premiere Pro'nun kendi Ctrl+Z geçmişiyle çakışmaması için, geri alma fonksiyonunu klavyeden **`Alt + Z`** kısayoluna bağla.

4. Whisper Otomatik Parçalama (app.js - APIManager):
- `APIManager.transcribe` işleminde, ses dosyasının süresi 15 dakikayı aşıyorsa, dosyayı FFmpeg kullanarak otomatik olarak 10 dakikalık parçalara (chunks) böl.
- Bu parçaları sırayla Whisper API'ye gönder, dönen zaman damgalarına offset ekleyerek birleştirip tek bir kelime dizisi döndür.
```

---

## 📋 [PROMPT 3] — Timeline Canlı Altyazı Enjeksiyon Motoru & Essential Graphics

**Hedef**: Altyazıları Premiere Pro timeline'ına canlı grafik klibi (Essential Graphics) olarak yazmak, renk/kutucuk özelliklerini uygulamak ve kelime bazlı "pop-in" vurguları yerleştirmek.

```markdown
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

---

## 📋 [PROMPT 4] — Akıllı SRT Bölme Motoru, FFmpeg Hızlandırma & Arayüz Kilitleme

**Hedef**: Karakter ve süre limitlerine göre otomatik altyazı bölme, arayüzden manuel bölme/birleştirme (Split & Merge), FFmpeg input-seeking optimizasyonu ve Premiere UI donmasını önleme.

```markdown
Rast Flow AI projemizde, altyazıların otomatik bölünmesini sağlayan bir akıllı motor, manuel Split/Merge arayüzü ve FFmpeg ile Premiere işlemlerini hızlandıracak performans optimizasyonlarını entegre etmek istiyoruz.

Lütfen şu geliştirmeleri yap:

1. Otomatik SRT Bölme Algoritması (app.js - SubtitleEngine):
- `autoSegmentSubtitles(maxChars = 35, maxDuration = 3.0, silenceThreshold = 0.5)` fonksiyonunu ekle.
- Bu fonksiyon: Noktalama işaretlerine (. , ? ! -), kelimeler arasındaki desibel/zaman boşluklarına, satır karakter limitine ve gösterim süresine bakarak otomatik bölme noktaları (segment breaks) hesaplasın ve bunları TranscriptStore'a kaydetsin.
- Transkript sekmesinin en üstündeki araç çubuğuna "🪄 Otomatik Böl" butonu ekle ve bu motoru tetikle.
- Manuel Split & Merge: Her altyazı kartının (subtitle-card) arasına ince interaktif bölme çizgisi koy. Çizgide bir "Birleştir" (Merge) butonu olsun; tıklandığında aradaki segment break'i kaldırsın. Her kelimeye sağ tıklandığında veya üzerine gelindiğinde "Buradan Böl" (Split) seçeneği sunulsun.

2. FFmpeg Hızlandırması (app.js - APIManager):
- `_extractAudio` fonksiyonunda kullanılan FFmpeg komut diziliminde `-ss` (seek) parametresini mutlaka `-i` parametresinden **önce** yaz (Input Seeking). Bu sayede uzun videolarda ses çıkarma hızı 10 kat artacaktır.

3. Premiere Arayüz Kilitleme (index.jsx):
- `rippleDeleteRanges` ve `createSubtitleGraphicClips` fonksiyonları çalışırken Premiere Pro arayüzünün gereksiz çizim yapıp donmasını engellemek için işlem döngülerinin en başına `app.userInputDisabled = true;` satırını ekle. İşlemler bittiğinde ve başarıyla tamamlandığında `app.userInputDisabled = false;` ile arayüz kilidini kaldır.
```

---

## 📋 [PROMPT 5] — AI Editor: Yapay Zeka ile Anlamlı Transkript Temizleme & Çekim Seçimi

**Hedef**: OpenAI GPT API'sini (veya Claude'u) eklentiye entegre etmek, transkriptteki kekelemeleri, stutters'ları ve hatalı çekimleri (multi-take) anlamsal olarak elenmesi için sistem promptuyla temizletmek, kelime ID'leriyle eşleştirip timeline kesimi hazırlamak.

```markdown
[PROMPT 5] — AI Editor: Yapay Zeka ile Anlamlı Transkript Temizleme & Çekim Seçimi (app.js, index.html, style.css)

Rast Flow AI projemize, sliding'ın OpenAI entegrasyonundan ilham alan ve transkripti anlamlı bir şekilde temizleyip hatalı çekimleri (multi-take) eleyen gelişmiş bir "AI Editor" sekmesi ve motoru eklemek istiyoruz.

Lütfen mevcut kod yapısına şu özellikleri entegre et:

1. UI Bölümü (index.html & style.css):
- Tab bar'a "AI Editör" isminde yeni bir sekme ekle ve bunun için `panelAiEditor` id'li bir panel oluştur.
- Panel içeriğinde:
  * Bir API Anahtarı giriş alanı (`aiApiKey` - input type="password") ve model seçim dropdown'ı (`aiModelSelect` - gpt-4o, gpt-4o-mini, claude-3-5-sonnet). Bu değerleri localStorage'a kaydet.
  * "🪄 Transkripti AI ile Temizle" butonu (`runAiCleanBtn`).
  * Analiz durumunu gösterecek bir durum çubuğu ve temizlenen kelime sayıları istatistiği.
  * Tespit edilen yapay zeka kesimlerinin gerekçelerini listeleyen bir `.ai-reasons-list` alanı.
- AI tarafından silinen kelimelere özel bir `.word.ai-deleted` sınıfı ekle (Bu kelimeler görsel olarak üzeri çizili gri renkte olmalı ve hover edildiğinde silinme gerekçesini tooltip olarak göstermelidir).

2. Yapay Zeka Temizlik Motoru & API Çağrısı (app.js):
- `AIEditorEngine` modülü oluştur.
- `cleanTranscriptWithAI()` fonksiyonunu yaz:
  * Transkriptteki aktif (silinmemiş) kelimeleri `[ { id, word } ]` formatında JSON olarak derle.
  * Seçilen API anahtarı ve modeli kullanarak doğrudan OpenAI veya Anthropic API'sine POST isteği gönder.
  * Sistem Prompt'u olarak modelden: Konuşmadaki tekrarları, kekelemeleri, dolgu kelimelerini (ııı, şey vb.) ve aynı cümlenin birden fazla kez denendiği hatalı çekimleri (multi-takes) tespit edip, sadece en akıcı ve doğru olan son çekimi tutarak diğer silinecek kelimelerin ID'lerini `deleted_word_ids` dizisi şeklinde döndürmesini iste.
  * Örnek API Çıktı Şeması: `{ "deleted_word_ids": [3, 5, 8], "reasons": [ { "id": 3, "text": "Kekeleme" }, { "id": 5, "text": "Hatalı Çekim (Multi-take)" } ] }`

3. Kelime Hizalama ve Kesim Senkronizasyonu (app.js):
- Dönen JSON verisindeki `deleted_word_ids` listesini oku ve transkript store'daki ilgili kelimeleri `deleted = true` olarak işaretle.
- Silinen kelimelerin üzerinde hover olunduğunda ilgili `reason.text` bilgisini transkript alanında tooltip olarak göster.
- Kullanıcı dilerse arayüzden bu kelimelere tıklayarak silme işaretini kaldırabilsin (Koru / Restore).
- Premiere Pro'ya Uygula butonuna basıldığında bu yapay zeka kesim aralıkları da timeline'dan otomatik olarak kesilip atılsın (Ripple Delete).
```
