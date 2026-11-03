// Reading goal and streak calculations. Days are local 'YYYY-MM-DD' keys.
const toUTC = key => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUTC = t => new Date(t).toISOString().slice(0, 10);
export const addDays = (key, n) => fromUTC(toUTC(key) + n * 86400000);
export const weekday = key => new Date(toUTC(key)).getUTCDay();
export const startOfWeek = (key, weekStart = 0) => addDays(key, -((weekday(key) - weekStart + 7) % 7));

// dayMs maps a day to the time read that day. Today and this week stay open:
// an unfinished day or week does not break a streak until it has passed.
export function computeStreaks({ dayMs, goalMs, weekGoalDays = 1, weekStart = 0, today }) {
  const hit = key => (dayMs.get(key) || 0) >= goalMs;
  const goalDays = [...dayMs.keys()].filter(hit).sort();

  let days = 0;
  let cursor = hit(today) ? today : addDays(today, -1);
  while (hit(cursor)) { days++; cursor = addDays(cursor, -1); }

  let bestDays = 0;
  let run = 0;
  let previous = null;
  for (const key of goalDays) {
    run = previous && addDays(previous, 1) === key ? run + 1 : 1;
    bestDays = Math.max(bestDays, run);
    previous = key;
  }

  const perWeek = new Map();
  for (const key of goalDays) {
    const week = startOfWeek(key, weekStart);
    perWeek.set(week, (perWeek.get(week) || 0) + 1);
  }
  const weekHit = week => (perWeek.get(week) || 0) >= weekGoalDays;
  const thisWeek = startOfWeek(today, weekStart);
  let weeks = 0;
  let w = weekHit(thisWeek) ? thisWeek : addDays(thisWeek, -7);
  while (weekHit(w)) { weeks++; w = addDays(w, -7); }

  let bestWeeks = 0;
  run = 0;
  previous = null;
  for (const week of [...perWeek.keys()].filter(weekHit).sort()) {
    run = previous && addDays(previous, 7) === week ? run + 1 : 1;
    bestWeeks = Math.max(bestWeeks, run);
    previous = week;
  }

  return {
    days, bestDays, weeks, bestWeeks,
    goalDaysThisWeek: perWeek.get(thisWeek) || 0,
    todayMs: dayMs.get(today) || 0,
    todayHit: hit(today),
  };
}

// Weeks of the given month as arrays of day keys, with null for days outside it.
export function monthGrid(year, month, weekStart = 0) {
  const pad = n => String(n).padStart(2, '0');
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const first = `${year}-${pad(month + 1)}-01`;
  const cells = new Array((weekday(first) - weekStart + 7) % 7).fill(null);
  for (let d = 1; d <= count; d++) cells.push(`${year}-${pad(month + 1)}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}
