/**
 * Stealth script injection for browser anti-detection
 * Patches browser APIs to hide automation
 */

import type { FingerprintProfile } from "./types.js";

export function getStealthScript(profile: FingerprintProfile): string {
  const profileJson = JSON.stringify(profile).replace(/</g, "\\u003c");
  return `
    const __qwenFingerprint = ${profileJson};

    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;

    // Chrome runtime object
    window.chrome = {
      runtime: {
        onMessage: { addListener: function() {} },
        sendMessage: function() {},
      },
      loadTimes: function() { return {}; },
      csi: function() { return {}; },
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      },
    };

    // Realistic plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      },
    });

    // MimeTypes
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const types = [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ];
        types.length = 2;
        return types;
      },
    });

    // Identity
    Object.defineProperty(navigator, 'userAgent', { get: () => __qwenFingerprint.userAgent });
    Object.defineProperty(navigator, 'appVersion', { get: () => __qwenFingerprint.appVersion });

    // Languages
    Object.defineProperty(navigator, 'languages', { get: () => __qwenFingerprint.languages });
    Object.defineProperty(navigator, 'language', { get: () => __qwenFingerprint.locale });

    // Hardware
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => __qwenFingerprint.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => __qwenFingerprint.deviceMemory });
    Object.defineProperty(navigator, 'platform', { get: () => __qwenFingerprint.platform });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });

    // User Agent Data (Client Hints)
    if ('userAgentData' in navigator) {
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: __qwenFingerprint.brands,
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: async (hints) => {
            const values = {
              architecture: 'x86',
              bitness: '64',
              brands: __qwenFingerprint.brands,
              fullVersionList: __qwenFingerprint.fullVersionList,
              mobile: false,
              model: '',
              platform: 'Windows',
              platformVersion: __qwenFingerprint.platformVersion,
              uaFullVersion: __qwenFingerprint.chromeVersion,
              wow64: false,
            };
            return hints.reduce((acc, hint) => {
              if (hint in values) acc[hint] = values[hint];
              return acc;
            }, {});
          },
          toJSON: () => ({
            brands: __qwenFingerprint.brands,
            mobile: false,
            platform: 'Windows',
          }),
        }),
      });
    }

    // Screen properties
    Object.defineProperty(screen, 'colorDepth', { get: () => __qwenFingerprint.colorDepth });
    Object.defineProperty(screen, 'pixelDepth', { get: () => __qwenFingerprint.pixelDepth });

    // Permissions API
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    // WebGL fingerprint
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return __qwenFingerprint.webglVendor;
      if (parameter === 37446) return __qwenFingerprint.webglRenderer;
      return getParameter.apply(this, arguments);
    };

    // Network connection
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
      }),
    });

    // Hide toString patches
    const nativeToString = Function.prototype.toString;
    const customFunctions = new Map();
    customFunctions.set(navigator.permissions.query, 'function query() { [native code] }');
    customFunctions.set(WebGLRenderingContext.prototype.getParameter, 'function getParameter() { [native code] }');
    Function.prototype.toString = function() {
      return customFunctions.get(this) || nativeToString.call(this);
    };
  `;
}
