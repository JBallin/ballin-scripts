/* global document, window */
// Only the configured public origin may load the third-party beacon.
// Even a production snapshot served by the loopback preview stays offline.
(() => {
  const config = document.currentScript;
  if (!config || window.location.origin !== config.dataset.origin) return;
  if (!/^[a-f0-9]{32}$/.test(config.dataset.token || '')) return;
  const beacon = document.createElement('script');
  beacon.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  beacon.defer = true;
  beacon.dataset.cfBeacon = JSON.stringify({ token: config.dataset.token });
  document.head.appendChild(beacon);
})();
