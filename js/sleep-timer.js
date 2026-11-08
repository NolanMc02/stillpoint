// Wall-clock duration and media-position chapter boundaries. Native playback
// events check deadlines too, because background browser timers can be delayed.
export class SleepTimer {
  constructor(audio, position, onExpire, onChange = () => {}) {
    this.audio = audio; this.position = position; this.onExpire = onExpire; this.onChange = onChange;
    this.check = () => {
      if (!this.kind) return;
      if ((this.kind === 'duration' && Date.now() >= this.deadline)
        || (this.kind === 'chapter' && this.position() >= this.endSeconds)) {
        const expired = this.state(); this.clear(); this.onExpire(expired); return;
      }
      this.onChange(this.state()); this.schedule();
    };
    for (const event of ['timeupdate', 'playing', 'seeked', 'ended']) audio.addEventListener(event, this.check);
  }
  duration(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Choose a sleep timer duration.');
    this.clear(); this.kind = 'duration'; this.minutes = minutes; this.deadline = Date.now() + minutes * 60000; this.check();
  }
  chapter(endSeconds) {
    if (!Number.isFinite(endSeconds) || endSeconds <= this.position()) throw new Error('There is no chapter remaining at this position.');
    this.clear(); this.kind = 'chapter'; this.endSeconds = endSeconds; this.check();
  }
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(this.check, this.kind === 'duration' ? Math.min(1000, Math.max(1, this.deadline - Date.now())) : 1000); }
  state() { return { kind: this.kind || 'off', minutes: this.minutes, remainingMs: this.kind === 'duration' ? Math.max(0, this.deadline - Date.now()) : null, endSeconds: this.endSeconds }; }
  clear() { clearTimeout(this.timer); this.kind = null; this.minutes = null; this.deadline = null; this.endSeconds = null; this.onChange(this.state()); }
  dispose() { this.clear(); for (const event of ['timeupdate', 'playing', 'seeked', 'ended']) this.audio.removeEventListener(event, this.check); }
}
