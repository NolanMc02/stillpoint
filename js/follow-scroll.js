// Keep several lines still between small, eased advances. Repeated words on a
// line do not restart an animation or recenter the viewport.
export class FollowScroll {
  follow(viewport, word) {
    if (!word) return;
    const frame = viewport.getBoundingClientRect(), rect = word.getBoundingClientRect();
    const height = viewport.clientHeight;
    if (rect.top >= frame.top + height * .28 && rect.bottom <= frame.top + height * .62) return;
    this.move(viewport, viewport.scrollTop + rect.top - frame.top - height * .42);
  }
  move(viewport, target) {
    target = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, target));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.cancel(); viewport.scrollTop = target; return; }
    this.target = target;
    if (this.active && this.viewport === viewport) return;
    this.cancel(); this.viewport = viewport; this.active = true; this.position = viewport.scrollTop;
    let last = performance.now();
    const step = now => {
      if (!viewport.isConnected) { this.cancel(); return; }
      const delta = this.target - this.position;
      const amount = 1 - Math.exp(-Math.min(50, now - last) / 140);
      last = now;
      if (Math.abs(delta) < 1) { viewport.scrollTop = this.target; this.cancel(); return; }
      this.position += delta * amount; viewport.scrollTop = this.position;
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }
  cancel() { cancelAnimationFrame(this.frame); this.active = false; }
}
