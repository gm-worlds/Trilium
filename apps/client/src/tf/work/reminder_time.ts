/**
 * The times a reminder can be set or snoozed to, computed from `now` in the browser's time zone.
 */
export type QuickChoiceKey = "in_1_hour" | "this_evening" | "tomorrow_morning" | "next_monday";

export interface QuickChoice {
    key: QuickChoiceKey;
    at: Date;
}

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;
/** "This evening" is left out once it is less than this far away. */
const EVENING_MIN_LEAD_MS = 30 * 60 * 1000;

export function quickChoices(now: Date): QuickChoice[] {
    const choices: QuickChoice[] = [ { key: "in_1_hour", at: inOneHour(now) } ];
    const evening = atLocal(now, 0, EVENING_HOUR);
    if (evening.getTime() - now.getTime() >= EVENING_MIN_LEAD_MS) {
        choices.push({ key: "this_evening", at: evening });
    }
    choices.push({ key: "tomorrow_morning", at: tomorrowMorning(now) });
    choices.push({ key: "next_monday", at: nextMonday(now) });
    return choices;
}

/** One hour from now, on the minute. */
export function inOneHour(now: Date): Date {
    const at = new Date(now.getTime() + 60 * 60 * 1000);
    at.setSeconds(0, 0);
    return at;
}

export function tomorrowMorning(now: Date): Date {
    return atLocal(now, 1, MORNING_HOUR);
}

/** 09:00 on the first Monday after today (a week on, when today is a Monday). */
export function nextMonday(now: Date): Date {
    const day = now.getDay();
    const days = ((8 - day) % 7) || 7;
    return atLocal(now, days, MORNING_HOUR);
}

/** `hour`:00 local time, `days` calendar days after `now`'s date (safe across DST changes). */
export function atLocal(now: Date, days: number, hour: number): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0, 0);
}

/** The local date (`YYYY-MM-DD`) and time (`HH:mm`) of `date`, for the pickers. */
export function toLocalParts(date: Date): { date: string; time: string } {
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
        date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        time: `${pad(date.getHours())}:${pad(date.getMinutes())}`
    };
}

/** The moment a local date and time stand for, or `null` when either is not valid. */
export function fromLocalParts(date: string, time: string): Date | null {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const t = /^(\d{2}):(\d{2})$/.exec(time);
    if (!d || !t) {
        return null;
    }
    const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0);
    return Number.isNaN(at.getTime()) ? null : at;
}

export type ReminderGroup = "overdue" | "today" | "later";

/** Which heading of the reminders list a due time falls under. */
export function reminderGroup(due: Date, now: Date): ReminderGroup {
    if (due.getTime() <= now.getTime()) {
        return "overdue";
    }
    return due.getTime() < atLocal(now, 1, 0).getTime() ? "today" : "later";
}

/** The time of day the way the person's language writes it: "18:00", "6:00 PM". */
export function formatClock(date: Date, locale?: string) {
    try {
        return new Intl.DateTimeFormat(locale || undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    } catch {
        return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
}

/** A due time as people read it in `locale`: "Wed 25 Nov, 18:00". */
export function formatWhen(date: Date, locale?: string) {
    try {
        return new Intl.DateTimeFormat(locale || undefined, {
            weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit"
        }).format(date);
    } catch {
        return date.toLocaleString();
    }
}
