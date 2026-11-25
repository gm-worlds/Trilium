import { describe, expect, it } from "vitest";

import { sanitizeColor, sanitizeCssValue, textColorOn } from "./theme.js";

describe("tf theme", () => {
    it("takes the host's colours as CSS colours, bare HSL triplets included", () => {
        expect(sanitizeColor("hsl(205 100% 65%)")).toBe("hsl(205 100% 65%)");
        expect(sanitizeColor("205 100% 65%")).toBe("hsl(205 100% 65%)");
        expect(sanitizeColor("#081a35")).toBe("#081a35");
        expect(sanitizeColor("red; background: url(x)")).toBeUndefined();
        expect(sanitizeColor(undefined)).toBeUndefined();
        expect(sanitizeCssValue(`"Source Sans 3", ${"system-ui, ".repeat(30)}sans-serif`)).toBeDefined();
    });

    it("puts black text on light accents and white text on dark ones", () => {
        expect(textColorOn("#081a35")).toBe("#ffffff");
        expect(textColorOn("#4fb3ff")).toBe("#000000");
        expect(textColorOn("#fff")).toBe("#000000");
    });
});
