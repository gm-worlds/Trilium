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
    const accent = sanitizeColor(theme.accent);
    const accentSolid = sanitizeColor(theme.accentSolid) ?? accent;
    setOrRemove(style, "--tf-accent", accent);
    setOrRemove(style, "--tf-accent-solid", accentSolid);
    setOrRemove(style, "--tf-on-accent", accentSolid ? textColorOn(accentSolid) : undefined);
    setOrRemove(style, "--tf-radius", typeof theme.radius === "number" && Number.isFinite(theme.radius)
        ? `${Math.max(0, Math.min(theme.radius, 32))}px` : undefined);
    setOrRemove(style, "--tf-font-sans", sanitizeCssValue(theme.fontSans));
    root.classList.toggle("tf-host-accent", !!accent);
    root.classList.toggle("tf-host-font", !!sanitizeCssValue(theme.fontSans) && options.get("overrideThemeFonts") !== "true");

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
 * layout reads. `keyboardInset` is the part of the frame the keyboard covers; it is 0 when the host
 * shrank the frame instead, and then `root_container.ts` notices the shorter window by itself. Only
 * a covered frame is reported the way `root_container.ts` reports an open keyboard, and only that
 * state is cleared again, so a 0 never hides a keyboard the root container detected.
 *
 * Dispatches {@link TF_VIEWPORT_EVENT} on `window` afterwards.
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
    const rootWidget = document.getElementById("root-widget");
    if (keyboard > 0) {
        body.setProperty("--tn-keyboard-height", `${keyboard}px`);
        body.setProperty("--tn-layout-overhang", `${keyboard}px`);
        body.setProperty("--tf-keyboard-inset", `${keyboard}px`);
        rootWidget?.classList.add("virtual-keyboard-opened");
        root.classList.add("tf-keyboard-covers");
    } else if (root.classList.contains("tf-keyboard-covers")) {
        body.setProperty("--tn-layout-overhang", "0px");
        body.removeProperty("--tf-keyboard-inset");
        rootWidget?.classList.remove("virtual-keyboard-opened");
        root.classList.remove("tf-keyboard-covers");
    }
    if (typeof viewport.coarse === "boolean") {
        root.classList.toggle("tf-coarse-pointer", viewport.coarse);
    }
    window.dispatchEvent(new CustomEvent(TF_VIEWPORT_EVENT, { detail: { ...viewport, keyboardInset: keyboard } }));
}

/** Fired on `window` after each host `viewport` message; `detail` is the viewport. */
export const TF_VIEWPORT_EVENT = "tf-viewport";

/** Drops values that could close the declaration and inject other CSS. */
export function sanitizeCssValue(value: string | undefined) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 400 || /[;{}<>\\]/.test(trimmed)) {
        return undefined;
    }
    return trimmed;
}

/**
 * A host colour as CSS accepts it: any CSS colour string, or a bare `H S% L%` triplet, which is
 * read as `hsl()`. `undefined` for anything the browser does not parse as a colour.
 */
export function sanitizeColor(value: string | undefined) {
    let color = sanitizeCssValue(value);
    if (color && /^\d+(\.\d+)?(deg)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(color)) {
        color = `hsl(${color})`;
    }
    if (color && typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports("color", color)) {
        return undefined;
    }
    return color;
}

/** Black or white, whichever reads better on `color`. */
export function textColorOn(color: string) {
    const rgb = resolveRgb(color);
    if (!rgb) {
        return "#ffffff";
    }
    const [ r, g, b ] = rgb.map((c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Contrast with white is 1.05 / (L + 0.05), with black (L + 0.05) / 0.05.
    return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.05 ? "#ffffff" : "#000000";
}

function resolveRgb(color: string): [number, number, number] | null {
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color)?.[1];
    if (hex) {
        const full = hex.length === 3 ? [ ...hex ].map((c) => c + c).join("") : hex;
        return [ 0, 2, 4 ].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
    }
    const probe = document.createElement("span");
    probe.style.color = color;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(computed);
    return match ? [ Number(match[1]), Number(match[2]), Number(match[3]) ] : null;
}

function setOrRemove(style: CSSStyleDeclaration, name: string, value: string | undefined) {
    if (value === undefined) {
        style.removeProperty(name);
    } else {
        style.setProperty(name, value);
    }
}
