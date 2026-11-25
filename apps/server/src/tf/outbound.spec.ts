import http from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    checkTfOutboundUrl, isTfPublicAddress, TF_OUTBOUND_MAX_BYTES, type TfOutboundDeps, tfOutboundFetch, tfOutboundGetImage
} from "./outbound.js";

let server: http.Server;
let port = 0;
const hits: string[] = [];

/** Deps that let a spec reach its own listener under a made-up public name, and nothing else local. */
function listenerDeps(): TfOutboundDeps {
    return {
        lookup: async (host) => {
            if (host === "listener.example") {
                return [ { address: "127.0.0.1", family: 4 } ];
            }
            if (host === "rebind.example") {
                return [ { address: "10.0.0.7", family: 4 } ];
            }
            throw new Error("not found");
        },
        isAllowedAddress: (address) => address === "127.0.0.1" || isTfPublicAddress(address),
        isAllowedPort: (url) => url.port === String(port)
    };
}

describe("tf outbound guard", () => {
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            hits.push(req.url ?? "");
            if (req.url === "/redirect-private") {
                res.writeHead(302, { location: "http://10.0.0.1/" }).end();
            } else if (req.url?.startsWith("/loop")) {
                const n = Number(req.url.slice(5) || "0");
                res.writeHead(302, { location: `http://listener.example:${port}/loop${n + 1}` }).end();
            } else if (req.url === "/rebind") {
                res.writeHead(302, { location: `http://rebind.example:${port}/` }).end();
            } else if (req.url === "/big") {
                res.writeHead(200, { "content-type": "application/octet-stream" });
                const chunk = Buffer.alloc(1024 * 1024);
                let sent = 0;
                const write = () => {
                    while (sent <= TF_OUTBOUND_MAX_BYTES / chunk.length + 1) {
                        sent++;
                        if (!res.write(chunk)) {
                            res.once("drain", write);
                            return;
                        }
                    }
                    res.end();
                };
                write();
            } else {
                res.writeHead(200, { "content-type": "image/png" }).end("PNG");
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
    });

    afterAll(() => {
        server.close();
    });

    it("refuses every non-public address form", () => {
        const refused = [
            "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
            "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "255.255.255.255", "224.0.0.1",
            "192.0.2.1", "198.18.0.1", "240.0.0.1", "::", "::1", "[::1]", "fe80::1", "fc00::1", "fd12:3456::1",
            "ff02::1", "::ffff:127.0.0.1", "[::ffff:127.0.0.1]", "::ffff:7f00:1", "::ffff:10.0.0.1",
            "::ffff:169.254.169.254", "::127.0.0.1", "::7f00:1", "::a00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1",
            "0x7f.1", "2130706433", "127.1", "not an address", ""
        ];
        for (const address of refused) {
            expect({ address, ok: isTfPublicAddress(address) }).toEqual({ address, ok: false });
        }
        for (const address of [ "8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "172.32.0.1", "100.128.0.1" ]) {
            expect({ address, ok: isTfPublicAddress(address) }).toEqual({ address, ok: true });
        }
    });

    it("refuses URLs by scheme, port, host form and normalised IP literal", () => {
        const refused = [
            "ftp://example.com/a", "file:///etc/passwd", "gopher://example.com/", "http://example.com:8080/",
            "https://example.com:80/", "http://localhost/", "http://intranet/", "http://printer.local/",
            "http://db.internal/", "http://nas.lan/", "http://router.home.arpa/", "http://x.localhost/",
            "http://evil.local./", "http://foo./", "not a url"
        ];
        for (const url of refused) {
            expect({ url, ok: tryCheck(url) }).toEqual({ url, ok: false });
        }
        // IP literals pass this step in their normalised form and are refused by the address check.
        expect(checkTfOutboundUrl("http://0x7f.1/").hostname).toBe("127.0.0.1");
        expect(checkTfOutboundUrl("http://2130706433/").hostname).toBe("127.0.0.1");
        expect(checkTfOutboundUrl("http://127.1/").hostname).toBe("127.0.0.1");
        expect(checkTfOutboundUrl("http://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
        expect(checkTfOutboundUrl("https://example.com:443/x").hostname).toBe("example.com");
    });

    it("refuses a real fetch to a local listener, whatever the spelling, and sends it nothing", async () => {
        const before = hits.length;
        for (const url of [
            `http://127.0.0.1:${port}/`, `http://localhost:${port}/`, "http://127.0.0.1/", "http://0x7f.1/",
            "http://2130706433/", "http://127.1/", "http://[::ffff:127.0.0.1]/", "http://[::1]/"
        ]) {
            await expect(tfOutboundFetch(url)).rejects.toThrow(/Refused/);
            await expect(tfOutboundGetImage(url)).rejects.toThrow(/Refused/);
        }
        expect(hits.length).toBe(before);
    });

    it("connects to the checked address, checks every redirect, and caps redirects and size", async () => {
        const deps = listenerDeps();
        const ok = await tfOutboundFetch(`http://listener.example:${port}/image`, {}, {}, deps);
        expect(await ok.text()).toBe("PNG");
        expect(new TextDecoder().decode(await tfOutboundGetImage(`http://listener.example:${port}/image`, deps))).toBe("PNG");

        await expect(tfOutboundFetch(`http://listener.example:${port}/redirect-private`, {}, {}, deps)).rejects.toThrow(/Refused/);
        await expect(tfOutboundFetch(`http://listener.example:${port}/rebind`, {}, {}, deps)).rejects.toThrow(/not public/);

        const before = hits.length;
        await expect(tfOutboundFetch(`http://listener.example:${port}/loop0`, {}, {}, deps)).rejects.toThrow(/more than 3 redirects/);
        expect(hits.length - before).toBe(4);

        const big = await tfOutboundFetch(`http://listener.example:${port}/big`, {}, {}, deps);
        const outcome = await big.arrayBuffer().then((buffer) => `read ${buffer.byteLength} bytes`, (e: unknown) => String(e));
        expect(outcome).toMatch(/20 MB/);
    });
});

function tryCheck(url: string) {
    try {
        checkTfOutboundUrl(url);
        return true;
    } catch {
        return false;
    }
}
