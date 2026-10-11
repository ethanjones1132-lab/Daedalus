/*
 * Human description of a 5-field cron expression. Covers the shapes the Add
 * Job form offers plus the common hand-written ones; anything else returns
 * null so the UI shows the expression alone rather than guessing.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isNum = (s: string) => /^\d+$/.test(s);

function clock(hour: string, minute: string): string | null {
  if (!isNum(hour) || !isNum(minute)) return null;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return null;
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

function dayName(token: string): string | null {
  if (!isNum(token)) return null;
  const n = Number(token) % 7;
  return Number(token) > 7 ? null : DAYS[n];
}

function plural(n: number, unit: string) {
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

export function describeSchedule(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (mon !== '*') return null;

  const step = (field: string) => {
    const match = /^\*\/(\d+)$/.exec(field);
    return match ? Number(match[1]) : null;
  };

  // Every N minutes / every minute
  if (hour === '*' && dom === '*' && dow === '*') {
    const n = step(min);
    if (min === '*') return 'every minute';
    if (n) return plural(n, 'minute');
    if (isNum(min)) return Number(min) === 0 ? 'every hour, on the hour' : `every hour at :${min.padStart(2, '0')}`;
    return null;
  }

  // Every N hours
  if (isNum(min) && dom === '*' && dow === '*') {
    const n = step(hour);
    if (n) return `${plural(n, 'hour')}${Number(min) === 0 ? '' : ` at :${min.padStart(2, '0')}`}`;
  }

  const at = clock(hour, min);
  if (!at) return null;

  // Every N days
  if (dow === '*') {
    if (dom === '*') return `daily at ${at}`;
    const n = step(dom);
    if (n) return `${plural(n, 'day')} at ${at}`;
    if (isNum(dom)) return `monthly on day ${dom} at ${at}`;
    return null;
  }

  if (dom !== '*') return null;
  if (dow === '1-5') return `weekdays at ${at}`;
  if (dow === '0,6' || dow === '6,0') return `weekends at ${at}`;
  const single = dayName(dow);
  if (single) return `${single}s at ${at}`;
  return null;
}
