import { describe, expect, it } from "vitest";

import { isSameServer, normalizeServerOrigin, parseConnectLink } from "./connect_link";

const CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

describe("connect link", () => {
    it("reads the link Taskforce hands out, pasted with noise or opened from the scheme", () => {
        const expected = { server: "https://nb-example.invalid", code: CODE };
        expect(parseConnectLink(`taskforce-notes://connect?server=https%3A%2F%2Fnb-example.invalid&code=${CODE}`)).toEqual(expected);
        expect(parseConnectLink(`  "taskforce-notes://connect/?server=https://nb-example.invalid/&code=${CODE.toLowerCase()}"\n`)).toEqual(expected);
        expect(parseConnectLink(`TASKFORCE-NOTES://Connect?code=${CODE}&server=https://NB-EXAMPLE.invalid`)).toEqual(expected);
        expect(parseConnectLink(`taskforce-notes:connect?server=https://nb-example.invalid&code=${CODE}`)).toEqual(expected);
        expect(parseConnectLink(`taskforce-notes://connect?server=http://127.0.0.1:4173&code=${CODE}`))
            .toEqual({ server: "http://127.0.0.1:4173", code: CODE });
    });

    it("refuses anything that could send the key elsewhere", () => {
        for (const link of [
            "",
            "not a link",
            `https://nb-example.invalid/connect?server=https://nb-example.invalid&code=${CODE}`,
            `taskforce-notes://pair?server=https://nb-example.invalid&code=${CODE}`,
            `taskforce-notes://connect?server=http://nb-example.invalid&code=${CODE}`,
            `taskforce-notes://connect?server=https://nb-example.invalid/api&code=${CODE}`,
            `taskforce-notes://connect?server=https://user:pw@nb-example.invalid&code=${CODE}`,
            `taskforce-notes://connect?server=https://nb-example.invalid?x=1&code=${CODE}`,
            `taskforce-notes://connect?server=javascript:alert(1)&code=${CODE}`,
            `taskforce-notes://connect?server=https://nb-example.invalid&code=SHORT`,
            `taskforce-notes://connect?server=https://nb-example.invalid&code=${CODE.replace("A", "1")}`,
            `taskforce-notes://connect?code=${CODE}`
        ]) {
            expect(parseConnectLink(link), link).toBeNull();
        }
    });

    it("compares notebook addresses by origin", () => {
        expect(normalizeServerOrigin("https://nb-example.invalid/")).toBe("https://nb-example.invalid");
        expect(isSameServer("https://nb-example.invalid", "https://NB-example.invalid/")).toBe(true);
        expect(isSameServer("https://nb-example.invalid", "https://nb-other.invalid")).toBe(false);
        expect(isSameServer("", "https://nb-example.invalid")).toBe(false);
    });
});
