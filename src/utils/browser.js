var browser = {
    init: function(){
      let res, ua, info;
      if (!(ua = typeof window !== 'undefined' && window.navigator && navigator.userAgent.toLowerCase())) {
        return {};
      }
      if ((res = /[( ]msie ([6789]|10).\d[);]/.exec(ua))) {
        info = {browser: 'ie', version: res[1]};
      }
      if ((res = /[( ]trident\/\d+(\.\d)+.*rv:(\d\d)(\.\d)+[);]/.exec(ua))) {
        info = {browser: 'ie', version: res[2]};
      }
      if (ua.indexOf('firefox') > -1) {
        info = {browser: 'firefox'};
      }
      if (ua.indexOf('chrome') > -1) {
        info = {browser: 'chrome'};
      }
      if (ua.indexOf('android') > -1) {
        info = {browser: 'android'};
      }
      let vendor = navigator.vendor;
      if (vendor && vendor.indexOf('Apple') > -1 && !ua.match('CriOS')) {
        info = {browser: 'safari'};
      }
      info = info || {};
      return {
        isIe: info.browser === 'ie',
        isFirefox: info.browser === 'firefox',
        isChrome: info.browser === 'chrome',
        isSafari: info.browser === 'safari',
        isAndroid: info.browser === 'android',
        browser: info,
        ua: ua,
      };
    }
};
export default browser;
