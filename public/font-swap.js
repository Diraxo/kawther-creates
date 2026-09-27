/* Turns the non-blocking (media=print) web-font stylesheet on once it has loaded. External file: the CSP allows no inline script. */
(function () {
  var l = document.getElementById('kc-fonts');
  if (!l) return;
  var on = function () { l.media = 'all'; };
  if (l.sheet) on(); else l.addEventListener('load', on);
})();
