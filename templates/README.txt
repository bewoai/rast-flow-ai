Rast Flow AI — Altyazı MOGRT Şablonu
=====================================

"✨ Animasyonlu Altyazı" butonu, bu klasördeki  caption.mogrt  şablonunu
her altyazı segmenti için timeline'a yerleştirir ve metnini doldurur.
STİL ve ANIMASYON tamamen şablonun içindedir — her kopya kendi animasyonunu
oynatır (AutoCut/FireCut'ın yöntemiyle aynı mantık).

Dosya adı tam olarak şu olmalı:
  templates/caption.mogrt


ŞABLONU PREMIERE'DE OLUŞTURMA (bir kez, ~1 dakika)
--------------------------------------------------
1. Boş bir sekans aç. En üste boş bir video kanalı olsun (örn. V3).
2. Type Tool (T) ile o kanala bir metin yaz: "Örnek Altyazı".
3. Essential Graphics panelini aç (Window > Essential Graphics) > Edit sekmesi.
   - Metin katmanını seç; font, boyut, renk, hizalama (alt-orta), istersen
     arka plan kutusu / stroke / gölge ver.
4. ANIMASYON (giriş): Metin klibi seçili. Effect Controls'ta klibin BAŞINDA
   birkaç karelik bir animasyon ekle, örn:
     - Opacity: 0 %  ->  100 %  (ilk 6-8 kare)  [fade-in]
     - veya Transform/Scale: 80 %  ->  100 %     [pop-in]
   (Bu keyframe'ler şablona gömülür ve her kopyada baştan oynar.)
5. Metin katmanı seçiliyken Essential Graphics panelinin en altındaki
   "Export Motion Graphics Template" (Hareketli Grafik Şablonu Olarak Aktar)
   düğmesine bas.
     - İsim: caption
     - Konum: "Local Templates Folder" yerine bu klasörü seçebilir ya da
       herhangi bir yere kaydedip dosyayı buraya kopyalayabilirsin.
6. Oluşan caption.mogrt dosyasını şu klasöre koy:
     <eklenti>/templates/caption.mogrt


NOTLAR
------
- Metin, şablonda DÜZENLENEBİLİR bir parametre olmalı (Premiere metin
  katmanını otomatik düzenlenebilir yapar). Eklenti metin parametresini
  adından (text / metin / source / title / altyazı) bulur; bulamazsa ilk
  metin parametresini dener.
- Altyazılar, sekanstaki EN ÜST video kanalına yerleştirilir. O kanalın
  ilgili zaman aralıklarının boş olmasına dikkat et.
- Metin doldurulamazsa eklenti "METİN doldurulamadı" uyarısı verir; o
  durumda şablonun metin parametresinin adını bana söyle, eşleştireyim.
