/**
 * Client side of Taskforce Notes, the fork's desktop build that syncs with one Taskforce notebook.
 * The server tells the renderer through the page bootstrap (`tfDesktop`), and the main process owns
 * the connection behind `window.electronApi.tfDesktop`. Outside that build everything here is inert.
 */
import type { ElectronTfDesktopApi, TfDesktopInfo } from "@triliumnext/commons";
import i18next from "i18next";

import { TF_DESKTOP_STRINGS_EN, TF_DESKTOP_STRINGS_NL } from "./strings.js";

interface TfDesktopGlob {
    tfDesktop?: { needsConnect: boolean };
}

/** Whether this page runs in Taskforce Notes. */
export function isTfDesktopClient() {
    return typeof window !== "undefined" && !!(window.glob as TfDesktopGlob | undefined)?.tfDesktop;
}

/** The main process's side of the connection; `null` outside Taskforce Notes. */
export function getTfDesktopApi(): ElectronTfDesktopApi | null {
    return isTfDesktopClient() ? window.electronApi?.tfDesktop ?? null : null;
}

let added = false;

/** Adds the `tfDesktop.*` strings to both namespaces (the app's and the entry pages'). */
export function addTfDesktopTranslations() {
    if (added || typeof i18next.addResourceBundle !== "function") {
        return;
    }
    added = true;
    for (const ns of [ "translation", "entry" ]) {
        i18next.addResourceBundle("en", ns, { tfDesktop: TF_DESKTOP_STRINGS_EN }, true, false);
        i18next.addResourceBundle("nl", ns, { tfDesktop: TF_DESKTOP_STRINGS_NL }, true, false);
    }
}

/** A `tfDesktop.*` string. */
export function tt(key: keyof typeof TF_DESKTOP_STRINGS_EN, options?: Record<string, unknown>): string {
    addTfDesktopTranslations();
    const translated = typeof i18next.t === "function"
        ? i18next.t(`tfDesktop.${key}`, { ...options, defaultValue: TF_DESKTOP_STRINGS_EN[key] }) as string
        : "";
    if (translated && translated !== `tfDesktop.${key}`) {
        return translated;
    }
    // Before i18next is initialised (and in specs that mock it): the English string.
    return TF_DESKTOP_STRINGS_EN[key].replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ""));
}

export type TfNoticeKind = "revoked" | "not_eligible" | "update_on_its_way" | "update_ready" | null;

/** Which notice the main window shows for a state; the stop wins over a ready update. */
export function noticeFor(info: TfDesktopInfo | null): TfNoticeKind {
    if (!info) {
        return null;
    }
    if (info.stop === "device_revoked") {
        return "revoked";
    }
    if (info.stop === "not_eligible") {
        return "not_eligible";
    }
    if (info.update.state === "ready") {
        return "update_ready";
    }
    if (info.stop === "sync_version") {
        return "update_on_its_way";
    }
    return null;
}

/** "25 Nov 2026, 14:03" in the reader's locale, from Trilium's UTC date format. */
export function formatSyncTime(utc: string, locale?: string) {
    if (!utc) {
        return "";
    }
    const date = new Date(utc.replace(" ", "T"));
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
