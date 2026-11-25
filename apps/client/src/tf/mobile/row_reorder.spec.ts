import { describe, expect, it } from "vitest";

import { neighbours } from "./row_reorder.js";

describe("neighbours of a note among its parent's children", () => {
    const rows = [ "a", "b", "c" ];

    it("the first has nothing before it, the last nothing after it", () => {
        expect(neighbours(rows, "a")).toEqual({ before: null, after: "b" });
        expect(neighbours(rows, "c")).toEqual({ before: "b", after: null });
    });

    it("a note in the middle has both", () => {
        expect(neighbours(rows, "b")).toEqual({ before: "a", after: "c" });
    });

    it("an only child, or a branch that is not there, has neither", () => {
        expect(neighbours([ "a" ], "a")).toEqual({ before: null, after: null });
        expect(neighbours(rows, "x")).toEqual({ before: null, after: null });
    });
});
