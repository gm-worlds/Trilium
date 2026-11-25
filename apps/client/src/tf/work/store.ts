/**
 * Client state of the work features: reminders per note and the person's own, and the last known
 * answer for each Taskforce chip. Components read it through {@link useTfWork}.
 */
import { useSyncExternalStore } from "preact/compat";

import { getTfBootstrap } from "../state.js";
import { reminders as remindersApi, type TfChipResult, type TfReminder } from "./api.js";

type Listener = () => void;

interface WorkState {
    /** Open reminders per note (`GET reminders?noteId=`), done ones left out. */
    byNote: Map<string, TfReminder[]>;
    /** The person's own open reminders in this notebook (`GET reminders?mine=1`). */
    mine: TfReminder[] | null;
    /** Chip answers by stored href. */
    chips: Map<string, TfChipResult>;
    /** Bumped on every change, so a snapshot comparison sees it. */
    version: number;
}

const state: WorkState = { byNote: new Map(), mine: null, chips: new Map(), version: 0 };
const listeners = new Set<Listener>();

export function subscribeTfWork(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function notifyTfWork() {
    state.version++;
    for (const listener of listeners) {
        listener();
    }
}

/** Re-renders the component whenever the work state changes. */
export function useTfWork() {
    useSyncExternalStore(subscribeTfWork, () => state.version);
    return state;
}

export function getTfWorkState() {
    return state;
}

export async function loadNoteReminders(noteId: string) {
    const list = await remindersApi.forNote(noteId);
    state.byNote.set(noteId, list.filter((r) => !r.doneAt));
    notifyTfWork();
    return list;
}

export async function loadMyReminders() {
    state.mine = (await remindersApi.mine()).filter((r) => !r.doneAt);
    notifyTfWork();
    return state.mine;
}

/** Applies a changed or new reminder everywhere it is listed. */
export function upsertReminder(reminder: TfReminder) {
    const me = getTfBootstrap()?.user?.id;
    const open = !reminder.doneAt;
    const forNote = (state.byNote.get(reminder.noteId) ?? []).filter((r) => r.id !== reminder.id);
    if (open) {
        forNote.push(reminder);
    }
    state.byNote.set(reminder.noteId, sortReminders(forNote));
    if (state.mine) {
        const mine = state.mine.filter((r) => r.id !== reminder.id);
        if (open && reminder.user?.id === me) {
            mine.push(reminder);
        }
        state.mine = sortReminders(mine);
    }
    notifyTfWork();
}

export function dropReminder(reminder: TfReminder) {
    state.byNote.set(reminder.noteId, (state.byNote.get(reminder.noteId) ?? []).filter((r) => r.id !== reminder.id));
    if (state.mine) {
        state.mine = state.mine.filter((r) => r.id !== reminder.id);
    }
    notifyTfWork();
}

export function setChipResult(href: string, result: TfChipResult) {
    state.chips.set(href, result);
}

export function getChipResult(href: string) {
    return state.chips.get(href);
}

/** When a reminder rings: its snooze time, else its due time. */
export function reminderTime(reminder: TfReminder) {
    return new Date(reminder.snoozedUntil ?? reminder.dueAt);
}

export function sortReminders(list: TfReminder[]) {
    return [ ...list ].sort((a, b) => reminderTime(a).getTime() - reminderTime(b).getTime());
}
