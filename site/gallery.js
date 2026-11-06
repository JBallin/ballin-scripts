/* global document, window, location */
// Copy only the displayed, escaped transcript; retain selection/download fallbacks.
document.querySelectorAll('[data-copy]').forEach(button => { button.hidden = false; });
document.addEventListener('click', async event => {
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

function revealFragment() {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const target = id && document.getElementById(id);
  if (!target) return;
  if (target.matches('.gallery-entry')) target.querySelector('details').open = true;
  for (let node = target; node; node = node.parentElement) {
    if (node.tagName === 'DETAILS') node.open = true;
  }
}
window.addEventListener('hashchange', revealFragment);
revealFragment();
