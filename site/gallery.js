/* global document, window, location */
// Copy only the displayed, escaped transcript; retain selection/download fallbacks.
document.querySelectorAll('[data-copy]').forEach(button => { button.hidden = false; });
document.addEventListener('click', async event => {
  const link = event.target.closest('a[href]');
  if (link && !event.defaultPrevented && event.button === 0 &&
      !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && url.pathname === location.pathname &&
        url.search === location.search && url.hash) revealFragment(url.hash);
  }
  const button = event.target.closest('[data-copy]');
  if (!button || button.disabled) return;
  const text = document.getElementById(button.dataset.copy);
  const status = document.getElementById(button.dataset.status);
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(text.textContent);
    status.textContent = 'Copied text.';
  } catch {
    status.textContent = 'Could not copy. Select the text or use Download text.';
  } finally {
    button.disabled = false;
  }
});

let fragmentSequence = 0;
function revealFragment(hash = location.hash) {
  const sequence = ++fragmentSequence;
  let id;
  try { id = decodeURIComponent(hash.slice(1)); } catch { return; }
  const target = id && document.getElementById(id);
  if (!target) return;
  if (target.matches('.gallery-entry')) {
    const output = target.querySelector('details:not(.provenance)');
    if (output) output.open = true;
  }
  for (let node = target; node; node = node.parentElement) {
    if (node.tagName === 'DETAILS') node.open = true;
  }
  // Re-align after disclosure layout and the browser's default fragment jump.
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (sequence === fragmentSequence) target.scrollIntoView({ block: 'start' });
  }));
}
window.addEventListener('hashchange', () => revealFragment());
revealFragment();
