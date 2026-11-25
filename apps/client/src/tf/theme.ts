/**
 * Host theme and viewport, applied to the notebook frame.
 *
 * The host's colours, corner radius and UI font arrive as `--tf-*` custom properties on `:root`;
 * `tf.css` maps them onto the Next theme's variables under `:root.tf-embedded`, so upstream theme
 * files stay untouched. Light or dark follows the host through the per-person `theme` option.
 */
import options from "../services/options.js";
import { applyThemeFromOptions } from "../services/theme.js";

export interface TfHostTheme {
    mode: "light" | "dark";
    accent: string;
    accentSolid: string;
    radius: number;
    fontSans: string;
}

export interface TfViewport {
    width: number;
    height: number;
    keyboardInset: number;
    safeTop: number;
    safeBottom: number;
    safeLeft: number;
    safeRight: number;
    coarse: boolean;
}

/** Applies the host theme. Resolves once the `theme` option matches the host's mode. */
export async function applyHostTheme(theme: Partial<TfHostTheme>, root: HTMLElement = document.documentElement) {
    const style = root.style;
    setOrRemove(style, "--tf-accent", sanitizeCssValue(theme.accent));
    setOrRemove(style, "--tf-accent-solid", sanitizeCssValue(theme.accentSolid ?? theme.accent));
    setOrRemove(style, "--tf-radius", typeof theme.radius === "number" && Number.isFinite(theme.radius)
        ? `${Math.max(0, Math.min(theme.radius, 32))}px` : undefined);
    setOrRemove(style, "--tf-font-sans", sanitizeCssValue(theme.fontSans));
    root.classList.toggle("tf-host-accent", !!theme.accent);
    root.classList.toggle("tf-host-font", !!theme.fontSans && options.get("overrideThemeFonts") !== "true");

    if (theme.mode === "light" || theme.mode === "dark") {
        const wanted = theme.mode === "dark" ? "next-dark" : "next-light";
        if (options.get("theme") !== wanted) {
            await options.save("theme", wanted);
            await applyThemeFromOptions();
        }
    }
}

/**
 * Applies the host's viewport: safe areas go to the `--safe-area-inset-*` properties the mobile
 * layout reads, and an open on-screen keyboard is reported the way `root_container.ts` reports it.
 */
export function applyViewport(viewport: Partial<TfViewport>, root: HTMLElement = document.documentElement) {
    const px = (value: number | undefined) => typeof value === "number" && Number.isFinite(value)
        ? `${Math.max(0, Math.round(value))}px` : undefined;

    setOrRemove(root.style, "--safe-area-inset-top", px(viewport.safeTop));
    setOrRemove(root.style, "--safe-area-inset-bottom", px(viewport.safeBottom));
    setOrRemove(root.style, "--safe-area-inset-left", px(viewport.safeLeft));
    setOrRemove(root.style, "--safe-area-inset-right", px(viewport.safeRight));

    const keyboard = Math.max(0, Math.round(viewport.keyboardInset ?? 0));
    const body = document.body.style;
    if (keyboard > 0) {
        body.setProperty("--tn-keyboard-height", `${keyboard}px`);
    }
    // The frame keeps its height while the host's keyboard covers its lower part.
    body.setProperty("--tn-layout-overhang", `${keyboard}px`);
    document.getElementById("root-container")?.classList.toggle("virtual-keyboard-opened", keyboard > 0);
    root.classList.toggle("tf-coarse-pointer", !!viewport.coarse);
}

/** Drops values that could close the declaration and inject other CSS. */
export function sanitizeCssValue(value: string | undefined) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 200 || /[;{}<>\\]/.test(trimmed)) {
        return undefined;
    }
    return trimmed;
}

function setOrRemove(style: CSSStyleDeclaration, name: string, value: string | undefined) {
    if (value === undefined) {
        style.removeProperty(name);
    } else {
        style.setProperty(name, value);
    }
}
