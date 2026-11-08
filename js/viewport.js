// Some installed iPhone web apps report a layout viewport shortened by the
// status-bar inset even with viewport-fit=cover. Fit the app surface, not its
// control padding, to the available screen. Never expand across the keyboard.
export function appViewportHeight({ height, visualHeight = height, offsetTop = 0, screenHeight, screenWidth, width, standalone, apple, safeTop = 0, safeBottom = 0 }) {
  const available = Math.round(visualHeight + offsetTop);
  if (!Number.isFinite(available) || available <= 0) return height;
  const gap = screenHeight - available;
  if (apple && standalone && Math.abs(screenWidth - width) <= 4 && gap > 0 && gap <= safeTop + safeBottom + 24) return screenHeight;
  return available;
}
export function fitAppViewport() {
  let frame;
  const update = () => {
    if (window.visualViewport && Math.abs(visualViewport.scale - 1) > .02) return;
    const css = getComputedStyle(document.documentElement);
    const height = appViewportHeight({ height: innerHeight, visualHeight: window.visualViewport?.height,
      offsetTop: window.visualViewport?.offsetTop || 0, width: innerWidth,
      screenHeight: screen.height, screenWidth: screen.width,
      standalone: navigator.standalone === true || matchMedia('(display-mode: standalone)').matches,
      apple: /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1,
      safeTop: parseFloat(css.getPropertyValue('--safe-t')) || 0, safeBottom: parseFloat(css.getPropertyValue('--safe-b')) || 0 });
    document.documentElement.style.setProperty('--app-height', `${height}px`);
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
  addEventListener('resize', schedule); addEventListener('orientationchange', schedule); addEventListener('pageshow', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  update();
}
