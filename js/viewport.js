// Stay inside the browser's usable viewport. Physical screen dimensions can
// include an unpainted iPhone area and must never enlarge the app surface.
export function appViewportHeight({ height, visualHeight = height, layoutHeight = height }) {
  return Math.floor(Math.min(...[height, visualHeight, layoutHeight].filter(n => Number.isFinite(n) && n > 0)));
}
export function fitAppViewport() {
  let frame;
  const update = () => {
    if (window.visualViewport && Math.abs(visualViewport.scale - 1) > .02) return;
    const height = appViewportHeight({ height: innerHeight, visualHeight: window.visualViewport?.height,
      layoutHeight: document.documentElement.clientHeight });
    if (Number.isFinite(height)) document.documentElement.style.setProperty('--app-height', `${height}px`);
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
  addEventListener('resize', schedule); addEventListener('orientationchange', schedule); addEventListener('pageshow', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  update();
}
