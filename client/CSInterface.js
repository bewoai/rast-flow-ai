/**
 * CSInterface.js — Adobe CEP (Common Extensibility Platform) API Bridge
 * PR Workflow AI — com.pr.workflow
 *
 * Bu dosya Adobe'nin resmi CEP kütüphanesinin güncel (v11) versiyonudur.
 * evalScript, getSystemPath, addEventListener gibi temel fonksiyonları içerir.
 */

'use strict';

var csInterface = null;

/* ─── Sabıtlar ─────────────────────────────────────────────────── */
const CSXSWindowType = {
  _PANEL        : "Panel",
  _MODELESS     : "Window",
  _MODAL_DIALOG : "ModalDialog"
};

const SystemPath = {
  APP           : "app",
  EXTENSION     : "extension",
  DESKTOP       : "desktop",
  DOCUMENTS     : "documents",
  PICTURES      : "pictures",
  TEMP          : "temp",
  HOST_APP      : "hostApp"
};

const ColorType = {
  rgb  : "rgb",
  none : "none"
};

const AppSkinInfo = function (baseFontFamily, baseFontSize, appBarBackgroundColor, panelBackgroundColor, appBarBackgroundColorSRGB, panelBackgroundColorSRGB) {
  this.baseFontFamily                = baseFontFamily;
  this.baseFontSize                  = baseFontSize;
  this.appBarBackgroundColor         = appBarBackgroundColor;
  this.panelBackgroundColor          = panelBackgroundColor;
  this.appBarBackgroundColorSRGB     = appBarBackgroundColorSRGB;
  this.panelBackgroundColorSRGB      = panelBackgroundColorSRGB;
};

/* ─── CSInterface Sınıfı ────────────────────────────────────────── */
function CSInterface() {
  this.version  = "11.0.0";
  this.hostEnv  = this._getHostEnv();
}

CSInterface.THEME_COLOR_CHANGED_EVENT = "com.adobe.csxs.events.ThemeColorChanged";
CSInterface.EXTENSION_UNLOADED_EVENT  = "com.adobe.csxs.events.ExtensionUnloaded";

/**
 * ExtendScript'teki bir fonksiyonu çalıştırır.
 * @param {string}   script   - Çalıştırılacak JS/JSX ifadesi
 * @param {Function} callback - Sonuçla çağrılacak callback(result, error)
 */
CSInterface.prototype.evalScript = function (script, callback) {
  if (!callback || typeof callback !== "function") {
    callback = function () {};
  }
  if (typeof window.__adobe_cep__ !== "undefined") {
    window.__adobe_cep__.evalScript(script, callback);
  } else {
    // Geliştirme ortamı (Premiere dışı): mock callback
    console.warn("[CSInterface] evalScript: Adobe CEP ortamı bulunamadı. Mock çalıştırılıyor.");
    setTimeout(() => callback("__MOCK__"), 100);
  }
};

/**
 * Sistemin özel klasör yollarını döndürür.
 * @param {string} pathType - SystemPath sabitlerinden biri
 * @returns {string} Tam yol
 */
CSInterface.prototype.getSystemPath = function (pathType) {
  var path = "";
  if (typeof window.__adobe_cep__ !== "undefined") {
    path = window.__adobe_cep__.getSystemPath(pathType);
  } else {
    // Mock: geliştirme ortamında geçici klasör
    const map = {
      temp      : "/tmp",
      documents : "/Users/user/Documents",
      desktop   : "/Users/user/Desktop",
      extension : "/path/to/extension"
    };
    path = map[pathType] || "/tmp";
  }
  // Windows yollarını normalize et
  if (path && path.charAt(0) === "/") return path;
  return path.replace(/\\/g, "/");
};

/**
 * Mevcut uzantının ID'sini döndürür.
 * @returns {string}
 */
CSInterface.prototype.getExtensionID = function () {
  if (typeof window.__adobe_cep__ !== "undefined") {
    return window.__adobe_cep__.getExtensionId();
  }
  return "com.pr.workflow.panel";
};

/**
 * Host uygulamasının bilgilerini döndürür.
 * @returns {object} {appName, appVersion}
 */
CSInterface.prototype.getHostEnvironment = function () {
  return this.hostEnv;
};

CSInterface.prototype._getHostEnv = function () {
  if (typeof window.__adobe_cep__ !== "undefined") {
    try {
      var envStr = window.__adobe_cep__.getHostEnvironment();
      return JSON.parse(envStr);
    } catch (e) {
      return { appName: "PPRO", appVersion: "24.0" };
    }
  }
  return { appName: "PPRO", appVersion: "24.0" };
};

/**
 * CEP olaylarını dinler.
 * @param {string}   type     - Olay türü (ör. "com.adobe.csxs.events.ThemeColorChanged")
 * @param {Function} listener - Olay işleyicisi
 */
CSInterface.prototype.addEventListener = function (type, listener) {
  if (typeof window.__adobe_cep__ !== "undefined") {
    window.__adobe_cep__.addEventListener(type, listener);
  } else {
    document.addEventListener(type, listener);
  }
};

/**
 * Olay dinleyicisini kaldırır.
 */
CSInterface.prototype.removeEventListener = function (type, listener) {
  if (typeof window.__adobe_cep__ !== "undefined") {
    window.__adobe_cep__.removeEventListener(type, listener);
  } else {
    document.removeEventListener(type, listener);
  }
};

/**
 * ExtendScript'e bir CEP olayı gönderir.
 * @param {CSEvent} event
 */
CSInterface.prototype.dispatchEvent = function (event) {
  if (typeof window.__adobe_cep__ !== "undefined") {
    window.__adobe_cep__.dispatchEvent(event);
  }
};

/**
 * Panelin görünür olup olmadığını ayarlar.
 * @param {boolean} visible
 */
CSInterface.prototype.setVisible = function (visible) {
  if (typeof window.__adobe_cep__ !== "undefined") {
    window.__adobe_cep__.setVisible(visible);
  }
};

/**
 * Uzantıyı kapatır.
 */
CSInterface.prototype.closeExtension = function () {
  if (typeof window.__adobe_cep__ !== "undefined") {
    window.__adobe_cep__.closeExtension();
  }
};

/**
 * Bir URL'yi varsayılan tarayıcıda açar.
 * @param {string} url
 */
CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  if (typeof window.__adobe_cep__ !== "undefined") {
    window.__adobe_cep__.openURLInDefaultBrowser(url);
  } else {
    window.open(url, "_blank");
  }
};

/**
 * Mevcut tema / skin bilgisini döndürür.
 * @returns {AppSkinInfo}
 */
CSInterface.prototype.getHostEnvironmentVariable = function (name) {
  if (typeof window.__adobe_cep__ !== "undefined") {
    return window.__adobe_cep__.getHostEnvironmentVariable(name);
  }
  return null;
};

/* ─── CSEvent ───────────────────────────────────────────────────── */
function CSEvent(type, scope, appId, extensionId) {
  this.type        = type;
  this.scope       = scope    || "APPLICATION";
  this.appId       = appId    || "PPRO";
  this.extensionId = extensionId || "";
  this.data        = "";
}

/* ─── Singleton ─────────────────────────────────────────────────── */
function getCSInterface() {
  if (!csInterface) {
    csInterface = new CSInterface();
  }
  return csInterface;
}

/* ─── Export ────────────────────────────────────────────────────── */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CSInterface, CSEvent, SystemPath, getCSInterface };
} else {
  window.CSInterface  = CSInterface;
  window.CSEvent      = CSEvent;
  window.SystemPath   = SystemPath;
  window.getCSInterface = getCSInterface;
}
