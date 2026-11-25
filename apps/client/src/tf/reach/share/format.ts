/** Dates of share links in the person's language. */

export function formatDay(iso: string) {
    return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

export function formatDayTime(iso: string) {
    return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function locale() {
    return document.documentElement.lang || undefined;
}
