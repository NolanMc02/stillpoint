// Narration progress is measured from finished words; packaging has its own phase.
export function duration(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m ${n % 60}s`;
  return `${Math.floor(n / 3600)}h ${Math.floor(n % 3600 / 60)}m`;
}

export function progressDetails(job, now = Date.now() / 1000) {
  const fraction = job.totalWords > 0 ? (job.completedWords || 0) / job.totalWords
    : job.total > 0 ? (job.completed || 0) / job.total : 0;
  const percent = job.status === 'ready' ? 100 : Math.max(0, Math.min(100, Math.floor(fraction * 100)));
  const running = job.status === 'running';
  const elapsed = (job.elapsedSeconds || 0) + (running && job.updatedAt ? Math.max(0, now - job.updatedAt) : 0);
  const finalizing = ['alignment', 'assembly', 'encoding', 'finishing'].includes(job.phase);
  const indeterminate = running && ['starting', 'loading', 'downloading', 'alignment', 'assembly', 'encoding', 'finishing'].includes(job.phase);
  let eta = running && job.phase === 'synthesis' && Number.isFinite(job.etaSeconds) ? job.etaSeconds : null;
  // Older running workers still report passage counts and active elapsed time.
  if (eta === null && running && job.phase === 'synthesis' && !job.totalWords && job.completed >= 3 && elapsed > 0) {
    eta = elapsed / job.completed * Math.max(0, job.total - job.completed);
  }
  return { percent, elapsed, eta, indeterminate, finalizing };
}
