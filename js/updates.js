// Refresh only app files. Books, audio and reading positions stay in IndexedDB.
export async function refreshInstalledApp(beforeReload = async () => {}) {
  if (!navigator.onLine) throw new Error('Connect to the internet to check for an update.');
  await beforeReload();
  if ('serviceWorker' in navigator) {
    let registration = await navigator.serviceWorker.getRegistration();
    if (registration) await registration.update();
    else registration = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    const worker = registration.installing || registration.waiting;
    if (worker && worker.state !== 'activated') {
      await new Promise((resolve, reject) => {
        const done = error => {
          clearTimeout(timer); worker.removeEventListener('statechange', changed);
          if (error) reject(error); else resolve();
        };
        const changed = () => {
          if (worker.state === 'activated') done();
          else if (worker.state === 'redundant') done(new Error('The update could not finish. Try again.'));
        };
        const timer = setTimeout(() => done(new Error('The update is still downloading. Try again shortly.')), 15000);
        worker.addEventListener('statechange', changed);
        changed();
      });
    }
  }
  location.reload();
}
