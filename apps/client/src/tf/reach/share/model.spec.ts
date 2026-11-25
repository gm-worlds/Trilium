import { describe, expect, it } from "vitest";

import { buildCreateBody, buildEndPatch, buildPasswordPatch, endDateFor, liveLinks, markerFor, type ShareLinkMeta, toDateInput } from "./model.js";

const now = new Date(2026, 10, 25, 14, 30, 0);

const link = (patch: Partial<ShareLinkMeta>): ShareLinkMeta => ({
    id: "l1", noteId: "n1", includeChildren: false, expiresAt: null, hasPassword: false,
    createdAt: "2026-11-20T10:00:00.000Z", createdBy: { id: "u1", name: "Ada" }, viewCount: 0,
    lastViewedAt: null, state: "live", ...patch
});

describe("share link form", () => {
    it("ends a link at the end of the day N days ahead in the person's time zone", () => {
        const in7 = endDateFor("7", "", now);
        expect(in7).toEqual(new Date(2026, 11, 2, 23, 59, 59, 999));
        expect(endDateFor("1", "", now)).toEqual(new Date(2026, 10, 26, 23, 59, 59, 999));
        expect(endDateFor("30", "", now)).toEqual(new Date(2026, 11, 25, 23, 59, 59, 999));
        expect(endDateFor("none", "", now)).toBeNull();
        expect(endDateFor("pick", "2027-01-09", now)).toEqual(new Date(2027, 0, 9, 23, 59, 59, 999));
        expect(endDateFor("pick", "2026-11-25", now)).toBe("invalid");
        expect(endDateFor("pick", "2026-02-30", now)).toBe("invalid");
        expect(endDateFor("pick", "", now)).toBe("invalid");
        expect(toDateInput(new Date(2027, 0, 9))).toBe("2027-01-09");
    });

    it("maps the form onto the request body, with the end date as ISO", () => {
        const built = buildCreateBody({ noteId: "n1", choice: "7", picked: "", password: "", includeChildren: false }, now);
        expect(built).toEqual({ body: {
            noteId: "n1",
            expiresAt: new Date(2026, 11, 2, 23, 59, 59, 999).toISOString(),
            includeChildren: false
        } });
        expect("body" in built && built.body.expiresAt?.endsWith("Z")).toBe(true);

        expect(buildCreateBody({ noteId: "n1", choice: "none", picked: "", password: "s3cret", includeChildren: true }, now))
            .toEqual({ body: { noteId: "n1", expiresAt: null, password: "s3cret", includeChildren: true } });
        expect(buildCreateBody({ noteId: "n1", choice: "7", picked: "", password: "abc", includeChildren: false }, now))
            .toEqual({ error: "password_short" });
        expect(buildCreateBody({ noteId: "n1", choice: "pick", picked: "2020-01-01", password: "", includeChildren: false }, now))
            .toEqual({ error: "pick_future" });
        expect(buildEndPatch("none", "", now)).toEqual({ body: { expiresAt: null } });
        expect(buildEndPatch("1", "", now)).toEqual({ body: { expiresAt: new Date(2026, 10, 26, 23, 59, 59, 999).toISOString() } });
        expect(buildPasswordPatch(null)).toEqual({ body: { password: null } });
        expect(buildPasswordPatch("ab")).toEqual({ error: "password_short" });
    });

    it("lists live links newest first and marks the title row with the latest end", () => {
        const links = [
            link({ id: "a", expiresAt: "2026-12-02T22:59:59.999Z", createdAt: "2026-11-21T10:00:00.000Z" }),
            link({ id: "b", expiresAt: "2026-12-09T22:59:59.999Z", createdAt: "2026-11-22T10:00:00.000Z" }),
            link({ id: "c", state: "revoked" }),
            link({ id: "d", expiresAt: "2026-11-01T00:00:00.000Z" })
        ];
        expect(liveLinks(links, now).map((l) => l.id)).toEqual([ "b", "a" ]);
        expect(markerFor(links, now)).toEqual({ kind: "until", until: "2026-12-09T22:59:59.999Z" });
        expect(markerFor([ ...links, link({ id: "e" }) ], now)).toEqual({ kind: "open" });
        expect(markerFor([ link({ state: "expired" }) ], now)).toBeNull();
    });
});
