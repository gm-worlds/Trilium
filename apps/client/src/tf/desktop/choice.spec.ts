import { describe, expect, it, vi } from "vitest";

import { choiceProps } from "./choice";

function key(k: string) {
    return { key: k, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

describe("choiceProps", () => {
    it("chooses with a click, Enter and Space, and is a focusable button", () => {
        const choose = vi.fn();
        const props = choiceProps(choose);
        expect(props.role).toBe("button");
        expect(props.tabIndex).toBe(0);
        expect(props["aria-disabled"]).toBeUndefined();
        props.onClick?.();
        const enter = key("Enter");
        props.onKeyDown(enter);
        props.onKeyDown(key(" "));
        props.onKeyDown(key("a"));
        expect(choose).toHaveBeenCalledTimes(3);
        expect(enter.preventDefault).toHaveBeenCalled();
    });

    it("without an action stays focusable, says it is unavailable and does nothing", () => {
        const props = choiceProps(undefined);
        expect(props.tabIndex).toBe(0);
        expect(props["aria-disabled"]).toBe(true);
        expect(props.onClick).toBeUndefined();
        const enter = key("Enter");
        props.onKeyDown(enter);
        expect(enter.preventDefault).not.toHaveBeenCalled();
    });
});
