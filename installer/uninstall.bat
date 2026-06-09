@echo off
chcp 65001 >nul
title Rast Flow AI — Kaldırma
echo.
echo  ═══════════════════════════════════════
echo    Rast Flow AI — Kaldırma
echo  ═══════════════════════════════════════
echo.

set "TARGET=%APPDATA%\Adobe\CEP\extensions\com.pr.workflow"

if exist "%TARGET%" (
    echo  [*] Eklenti kaldırılıyor...
    rmdir /s /q "%TARGET%"
    echo  ✅ Kaldırma tamamlandı.
) else (
    echo  ⚠ Eklenti zaten kurulu değil.
)

echo.
echo  Premiere Pro'yu yeniden başlatmanız gerekebilir.
echo.
pause
