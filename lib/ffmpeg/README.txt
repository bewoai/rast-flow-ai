PR Workflow AI — FFmpeg
========================

Bu eklenti, Premiere export/preset pipeline'ını KULLANMADAN, timeline'daki
klibin kaynak medya dosyasından sesi doğrudan FFmpeg ile çıkarır. Adobe Media
Encoder veya .epr preset GEREKMEZ.

KURULUM (bir kez, paketleme aşamasında):
-----------------------------------------
Aşağıdaki klasöre platforma uygun ffmpeg ikili dosyasını kopyalayın:

  Windows : com.pr.workflow/lib/ffmpeg/ffmpeg.exe
  macOS   : com.pr.workflow/lib/ffmpeg/ffmpeg   (chmod +x)

İndirme:
  Windows : https://www.gyan.dev/ffmpeg/builds/  (ffmpeg-release-essentials.zip → bin/ffmpeg.exe)
  macOS   : https://evermeet.cx/ffmpeg/          (ffmpeg)

İkili dosya buraya konduğunda eklenti onu OTOMATİK bulur; son kullanıcı hiçbir
şey yapmaz, sadece "Transkript Oluştur"a basar.

NOT:
- FFmpeg bulunamazsa, eklenti önce sistem PATH'indeki ffmpeg'i dener.
- O da yoksa, ses dosyaları için tarayıcının yerleşik çözücüsüne (WebAudio)
  düşer; ancak video kapsayıcıları (MP4/MOV) için FFmpeg önerilir.
