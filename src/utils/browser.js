var browser = {
    isSafari: function(){
      let vendor = navigator.vendor, userAgent = navigator.userAgent;
      return vendor && vendor.indexOf('Apple') > -1 && userAgent && !userAgent.match('CriOS');
    }
};
export default browser;
