const DAY = 864e5;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = MONTHS.join("|");

const sod = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const span = (start: Date, endDay: Date): [string, string] => [start.toISOString(), new Date(endDay.getTime() + DAY - 1).toISOString()];
const monthIdx = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.slice(0, 3).toLowerCase()));

function explicitDate(u: string, today: Date): Date | null {
  let d: string | undefined, m: string | undefined, y: string | undefined;
  let r = u.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\b(?:,?\\s+(\\d{4}))?`));
  if (r) [, d, m, y] = r;
  else {
    r = u.match(new RegExp(`\\b(${MON}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`));
    if (r) [, m, d, y] = r;
  }
  if (!d || !m) return null;
  const mi = monthIdx(m);
  if (mi < 0) return null;
  let year = y ? Number(y) : today.getUTCFullYear();
  let date = new Date(Date.UTC(year, mi, Number(d)));
  if (!y && date.getTime() > today.getTime()) date = new Date(Date.UTC(year - 1, mi, Number(d)));
  return date;
}

/**
 * Resolves relative/absolute date phrases in code (never by the LLM).
 * Assumption: "on <weekday>" = most recent occurrence (today counts); "last <weekday>" = strictly before today.
 * Returns inclusive [startISO, endISO] in UTC, or null.
 */
export function resolveRelative(utterance: string, now = new Date()): [string, string] | null {
  const u = utterance.toLowerCase();
  const today = sod(now);

  const abs = explicitDate(u, today);
  if (abs) return span(abs, abs);

  const wd = WEEKDAYS.join("|");
  const last = u.match(new RegExp(`\\blast\\s+(${wd})\\b`));
  if (last) {
    const diff = ((today.getUTCDay() - WEEKDAYS.indexOf(last[1]) + 7) % 7) || 7;
    const d = new Date(today.getTime() - diff * DAY);
    return span(d, d);
  }

  if (/\blast\s+week\b/.test(u)) {
    const dow = (today.getUTCDay() + 6) % 7; // Mon=0
    const thisMon = new Date(today.getTime() - dow * DAY);
    const start = new Date(thisMon.getTime() - 7 * DAY);
    return span(start, new Date(thisMon.getTime() - DAY));
  }

  if (/\byesterday\b/.test(u)) {
    const d = new Date(today.getTime() - DAY);
    return span(d, d);
  }

  const on = u.match(new RegExp(`\\b(?:on|this)\\s+(${wd})\\b`));
  if (on) {
    const diff = (today.getUTCDay() - WEEKDAYS.indexOf(on[1]) + 7) % 7;
    const d = new Date(today.getTime() - diff * DAY);
    return span(d, d);
  }

  if (/\btoday\b/.test(u)) return span(today, today);
  return null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayLabel(now = new Date()): string {
  return `${now.toISOString().slice(0, 10)} (${WEEKDAYS[now.getUTCDay()][0].toUpperCase()}${WEEKDAYS[now.getUTCDay()].slice(1)}, UTC)`;
}
