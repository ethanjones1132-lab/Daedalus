import { describe, expect, it } from 'vitest';
import { describeSchedule } from './cron-schedule';

describe('describeSchedule', () => {
  it.each([
    ['* * * * *', 'every minute'],
    ['*/5 * * * *', 'every 5 minutes'],
    ['0 * * * *', 'every hour, on the hour'],
    ['15 * * * *', 'every hour at :15'],
    ['0 */6 * * *', 'every 6 hours'],
    ['0 */12 * * *', 'every 12 hours'],
    ['0 3 * * *', 'daily at 3am'],
    ['0 0 * * *', 'daily at 12am'],
    ['30 14 * * *', 'daily at 2:30pm'],
    ['0 3 */2 * *', 'every 2 days at 3am'],
    ['0 8 * * 1', 'Mondays at 8am'],
    ['0 9 * * 1-5', 'weekdays at 9am'],
    ['0 10 * * 0', 'Sundays at 10am'],
    ['0 10 * * 7', 'Sundays at 10am'],
    ['0 6 1 * *', 'monthly on day 1 at 6am'],
  ])('describes %s', (expr, text) => {
    expect(describeSchedule(expr)).toBe(text);
  });

  it.each(['', 'not cron', '0 3 * *', '0 3 * 6 *', '61 3 * * *', '0 25 * * *', '0 3 1 * 1'])(
    'returns null rather than guessing for %j',
    (expr) => {
      expect(describeSchedule(expr)).toBeNull();
    },
  );
});
