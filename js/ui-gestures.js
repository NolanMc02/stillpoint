// Reader text size belongs to Appearance; page zoom destabilizes the app chrome.
export function preventAppZoom() {
  const block = event => { if (event.cancelable) event.preventDefault(); };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, block, { passive: false });
  for (const type of ['touchstart', 'touchmove']) document.addEventListener(type, event => {
    if (event.touches?.length > 1) block(event);
  }, { passive: false });
  document.addEventListener('wheel', event => { if (event.ctrlKey) block(event); }, { passive: false });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '0'].includes(event.key)) block(event);
  });
}
