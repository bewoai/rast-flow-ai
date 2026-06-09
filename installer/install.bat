@echo off
chcp 65001 >nul
title Rast Flow AI — Kurulum
echo.
echo  ═══════════════════════════════════════
echo    Rast Flow AI — Otomatik Kurulum
echo  ═══════════════════════════════════════
echo.

:: Hedef klasör
set "TARGET=%APPDATA%\Adobe\CEP\extensions\com.pr.workflow"

:: Eski kurulum varsa temizle
if exist "%TARGET%" (
    echo  [*] Eski kurulum kaldırılıyor...
    rmdir /s /q "%TARGET%" 2>nul
)

:: Kaynak klasörü bul (bu .bat'ın yanındaki dosyalar)
set "SOURCE=%~dp0"

:: Dosyaları kopyala
echo  [*] Dosyalar kopyalanıyor...
xcopy "%SOURCE%client" "%TARGET%\client\" /E /I /Q /Y >nul
xcopy "%SOURCE%host" "%TARGET%\host\" /E /I /Q /Y >nul
xcopy "%SOURCE%CSXS" "%TARGET%\CSXS\" /E /I /Q /Y >nul
xcopy "%SOURCE%fonts" "%TARGET%\fonts\" /E /I /Q /Y >nul
xcopy "%SOURCE%templates" "%TARGET%\templates\" /E /I /Q /Y >nul
if exist "%SOURCE%lib" xcopy "%SOURCE%lib" "%TARGET%\lib\" /E /I /Q /Y >nul
if exist "%SOURCE%index.js" copy "%SOURCE%index.js" "%TARGET%\index.js" /Y >nul

:: PlayerDebugMode — imzasız eklentilerin çalışmasını sağlar
echo  [*] Adobe ayarları yapılandırılıyor...
for %%V in (8 9 10 11 12) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>nul
)

:: Fontları kur (isteğe bağlı)
echo  [*] Fontlar yükleniyor...
set "FONTDIR=%LOCALAPPDATA%\Microsoft\Windows\Fonts"
if not exist "%FONTDIR%" mkdir "%FONTDIR%"
for %%f in ("%SOURCE%fonts\*.otf") do (
    copy "%%f" "%FONTDIR%\" /Y >nul 2>nul
)

echo.
echo  ✅ Kurulum tamamlandı!
echo.
echo  Sonraki adımlar:
echo    1. Adobe Premiere Pro'yu açın (veya yeniden başlatın)
echo    2. Menü: Pencere → Uzantılar → Rast Flow AI
echo.
echo  Kurulum yeri: %TARGET%
echo.
pause
