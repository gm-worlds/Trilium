/**
 * Share links that end: the shapes of the Taskforce routes (`share-links`, contract "Share
 * links"), what the dialog's choices send, and what the title row says. Pure, for the specs.
 */

export type ShareLinkState = "live" | "expired" | "revoked";

export interface ShareLinkMeta {
    id: string;
    noteId: string;
    includeChildren: boolean;
    expiresAt: string | null;
    hasPassword: boolean;
    createdAt: string;
    createdBy: { id: string; name: string } | null;
    viewCount: number;
    lastViewedAt: string | null;
    state: ShareLinkState;
}

export type ShareLinkCreated = ShareLinkMeta & { url: string };

export type EndChoice = "1" | "7" | "30" | "pick" | "none";
export const END_CHOICES: EndChoice[] = [ "1", "7", "30", "pick", "none" ];
export const DEFAULT_END_CHOICE: EndChoice = "7";
export const PASSWORD_MIN = 4;

/**
 * When a link chosen as `choice` ends, in the person's own time zone: the end of the day N days
 * from today, or of the picked day (`yyyy-mm-dd`). `null` for no end date, `"invalid"` for a
 * picked day that is not after today or cannot be read.
 */
export function endDateFor(choice: EndChoice, picked: string, now: Date): Date | null | "invalid" {
    if (choice === "none") {
        return null;
    }
    if (choice === "pick") {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(picked.trim());
        if (!match) {
            return "invalid";
        }
        const [ , year, month, day ] = match.map(Number);
        const end = new Date(year, month - 1, day, 23, 59, 59, 999);
        if (end.getMonth() !== month - 1 || end.getDate() !== day || end.getTime() <= endOfDay(now, 0).getTime()) {
            return "invalid";
        }
        return end;
    }
    return endOfDay(now, Number(choice));
}

function endOfDay(now: Date, daysAhead: number) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, 23, 59, 59, 999);
}

/** The `yyyy-mm-dd` of `date` in local time, for a date field. */
export function toDateInput(date: Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface CreateForm {
    noteId: string;
    choice: EndChoice;
    picked: string;
    password: string;
    includeChildren: boolean;
}

export type FormError = "pick_future" | "password_short";

export interface CreateBody {
    noteId: string;
    expiresAt: string | null;
    password?: string;
    includeChildren: boolean;
}

/** The body of `POST share-links` for the form, or what is wrong with it. */
export function buildCreateBody(form: CreateForm, now: Date): { body: CreateBody } | { error: FormError } {
    const end = endDateFor(form.choice, form.picked, now);
    if (end === "invalid") {
        return { error: "pick_future" };
    }
    if (form.password && form.password.length < PASSWORD_MIN) {
        return { error: "password_short" };
    }
    return {
        body: {
            noteId: form.noteId,
            expiresAt: end ? end.toISOString() : null,
            ...(form.password ? { password: form.password } : {}),
            includeChildren: form.includeChildren
        }
    };
}

/** The body of `PATCH share-links/:id` for a new end date. */
export function buildEndPatch(choice: EndChoice, picked: string, now: Date): { body: { expiresAt: string | null } } | { error: FormError } {
    const end = endDateFor(choice, picked, now);
    if (end === "invalid") {
        return { error: "pick_future" };
    }
    return { body: { expiresAt: end ? end.toISOString() : null } };
}

/** The body of `PATCH share-links/:id` that sets (`password`) or removes (`null`) the password. */
export function buildPasswordPatch(password: string | null): { body: { password: string | null } } | { error: FormError } {
    if (password !== null && password.length < PASSWORD_MIN) {
        return { error: "password_short" };
    }
    return { body: { password } };
}

/** The links that still open, newest first. */
export function liveLinks(links: ShareLinkMeta[], now: Date = new Date()) {
    return links
        .filter((link) => link.state === "live" && (!link.expiresAt || Date.parse(link.expiresAt) > now.getTime()))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export type ShareMarker = { kind: "until"; until: string } | { kind: "open" } | null;

/** What the title row says: shared until the latest end, or open-ended when any link has none. */
export function markerFor(links: ShareLinkMeta[], now: Date = new Date()): ShareMarker {
    const live = liveLinks(links, now);
    if (!live.length) {
        return null;
    }
    if (live.some((link) => !link.expiresAt)) {
        return { kind: "open" };
    }
    const latest = live.reduce((a, b) => (Date.parse(a.expiresAt ?? "") >= Date.parse(b.expiresAt ?? "") ? a : b));
    return { kind: "until", until: latest.expiresAt ?? "" };
}

/** Which end choice describes a link's end date best, for its "Change end date" form. */
export function choiceForExisting(expiresAt: string | null): EndChoice {
    return expiresAt ? "pick" : "none";
}
