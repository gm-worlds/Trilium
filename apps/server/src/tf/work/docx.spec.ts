import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";
import { parseStringPromise } from "xml2js";
import yauzl from "yauzl";

import { buildTfDocx, imageSize } from "./docx.js";

/** A real PNG of `width` x `height` grey pixels. */
function png(width: number, height: number): Uint8Array {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        return c >>> 0;
    });
    const crc = (bytes: Buffer) => {
        let c = 0xffffffff;
        for (const byte of bytes) {
            c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        }
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([ Buffer.from(type, "ascii"), data ]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([ length, body, sum ]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 0;
    const raw = Buffer.alloc((width + 1) * height, 0x99);
    for (let y = 0; y < height; y++) {
        raw[y * (width + 1)] = 0;
    }
    return new Uint8Array(Buffer.concat([
        Buffer.from([ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ]),
        chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))
    ]));
}

function unzip(bytes: Uint8Array): Promise<Map<string, string>> {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
            if (error || !zip) {
                reject(error);
                return;
            }
            const files = new Map<string, string>();
            zip.on("entry", (entry: yauzl.Entry) => {
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) {
                        reject(streamError);
                        return;
                    }
                    const chunks: Buffer[] = [];
                    stream.on("data", (c: Buffer) => chunks.push(c));
                    stream.on("end", () => {
                        files.set(entry.fileName, entry.fileName.startsWith("word/media/") ? `binary:${Buffer.concat(chunks).length}` : Buffer.concat(chunks).toString("utf8"));
                        zip.readEntry();
                    });
                });
            });
            zip.on("end", () => resolve(files));
            zip.readEntry();
        });
    });
}

const IMAGE = png(1200, 400);

const HTML = `
<h2>Launch plan</h2>
<p>Plain <strong>bold</strong> <i>italic</i> <u>under</u> <s>gone</s> <code>inline()</code>
  <a href="https://example.com/x">a link</a> and <a class="tf-chip" data-tf-kind="task" href="/p/abc?task=def">Book the printer</a>
  and <span class="math-tex">\\(E=mc^2\\)</span>.<span class="footnote-reference" data-footnote-reference data-footnote-id="f1"><sup><a href="#fnf1">[1]</a></sup></span></p>
<ul><li>Bullet one<ul><li>Nested bullet</li></ul></li><li>Bullet two</li></ul>
<ol start="3"><li>Third</li><li>Fourth</li></ol>
<ul class="todo-list"><li><label class="todo-list__label"><input type="checkbox" disabled="disabled" checked="checked"><span class="todo-list__label__description">Done item</span></label></li>
<li><label class="todo-list__label"><input type="checkbox" disabled="disabled"><span class="todo-list__label__description">Open item</span></label></li></ul>
<figure class="table"><table><thead><tr><th>Name</th><th>Role</th><th>Hours</th></tr></thead>
<tbody><tr><td colspan="2">Merged across</td><td rowspan="2">8</td></tr><tr><td>Ada</td><td>Lead</td></tr></tbody></table></figure>
<figure class="image"><img src="api/attachments/att1/image/plan.png" alt="Plan picture"></figure>
<pre><code class="language-js">const a = 1;
console.log(a);</code></pre>
<blockquote><p>A quoted line</p></blockquote>
<aside class="admonition warning"><p>Mind the gap</p></aside>
<div class="page-break" style="page-break-after:always;"><span style="display:none;">&nbsp;</span></div>
<hr>
<div class="tf-docx-include" data-title="Included"><p>From the included note</p></div>
<ol class="footnote-section footnotes" data-footnote-section><li class="footnote-item" data-footnote-item data-footnote-id="f1"><div class="footnote-content" data-footnote-content><p>The footnote text</p></div></li></ol>`;

describe("tf Word export", () => {
    it("reads image sizes from file headers", () => {
        expect(imageSize(IMAGE)).toEqual({ width: 1200, height: 400 });
        expect(imageSize(new Uint8Array([ 1, 2, 3 ]))).toBeNull();
    });

    it("writes every element type into a well-formed document", async () => {
        const bytes = await buildTfDocx({ title: "Launch", notes: [
            { noteId: "n1", title: "Launch", level: 0, html: HTML },
            { noteId: "n2", title: "Child note", level: 1, html: "<h2>Child heading</h2><p>Child text</p>" }
        ] }, {
            resolveImage: (src) => src.includes("att1") ? { data: IMAGE, mime: "image/png" } : null,
            linkBase: "https://taskforce.example"
        });
        if (process.env.TF_DOCX_OUT) {
            writeFileSync(process.env.TF_DOCX_OUT, bytes);
        }
        const files = await unzip(bytes);
        const xml = files.get("word/document.xml") ?? "";
        await expect(parseStringPromise(xml)).resolves.toBeTruthy();
        for (const name of [ "word/footnotes.xml", "word/numbering.xml", "word/styles.xml", "word/_rels/document.xml.rels", "[Content_Types].xml" ]) {
            await expect(parseStringPromise(files.get(name) ?? "")).resolves.toBeTruthy();
        }

        const text = (needle: string) => expect(xml).toContain(needle);
        text(`<w:pStyle w:val="Heading1"/>`);
        text(`<w:pStyle w:val="Heading2"/>`);
        text(`<w:pStyle w:val="Heading3"/>`);
        text(">Launch plan<");
        text(">Child heading<");
        text("<w:b/>");
        text("<w:i/>");
        text(`<w:u w:val="single"/>`);
        text("<w:strike/>");
        text(`w:ascii="Consolas"`);
        text(">E=mc^2<");
        text("<w:hyperlink");
        text("<w:footnoteReference");
        text(`<w:numPr>`);
        text(">☑ <");
        text(">☐ <");
        text("<w:tbl>");
        text("<w:tblHeader/>");
        text(`<w:gridSpan w:val="2"/>`);
        text(`<w:vMerge w:val="restart"/>`);
        text(`<w:vMerge w:val="continue"/>`);
        text(`w:type="page"`);
        text(">Warning: <");
        text(">Mind the gap<");
        text(">A quoted line<");
        text(">From the included note<");
        text(">console.log(a);<");
        text("<w:drawing>");

        const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml);
        expect(Number(extent?.[1])).toBe(600 * 9525);
        expect(Number(extent?.[2])).toBe(200 * 9525);
        expect(files.get("word/_rels/document.xml.rels")).toMatch(/relationships\/image" Target="media\//);
        expect([ ...files.keys() ].some((name) => name.startsWith("word/media/"))).toBe(true);
        expect(files.get("word/_rels/document.xml.rels")).toContain("https://taskforce.example/p/abc?task=def");
        expect(files.get("word/footnotes.xml")).toContain("The footnote text");
        expect(files.get("word/numbering.xml")).toContain(`<w:start w:val="3"/>`);
    });
});
