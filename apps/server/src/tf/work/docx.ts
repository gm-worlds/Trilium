/**
 * Turns notes into a Word document (.docx) with the `docx` library and a walker over the stored
 * HTML (`node-html-parser`). Covers what text notes hold: headings, paragraphs, inline formatting,
 * links, nested and to-do lists, tables with header rows and merged cells, images from
 * attachments, code blocks, quotes, admonitions, footnotes, page breaks, horizontal lines,
 * included notes, Taskforce chips (as links) and maths (as its source).
 */
import type { TfDocxImage, TfDocxSource } from "@triliumnext/core/src/tf/work/index.js";
import {
    AlignmentType, BorderStyle, Document, ExternalHyperlink, FootnoteReferenceRun, HeadingLevel, ImageRun,
    type ILevelsOptions, type IParagraphOptions, type IRunOptions, LevelFormat, Packer, PageBreak, Paragraph,
    type ParagraphChild, ShadingType, Table, TableCell, TableRow, TextRun, WidthType
} from "docx";
import { type HTMLElement, type Node, NodeType, parse } from "node-html-parser";

export interface TfDocxOptions {
    /** Bytes of an image `src`, or `null` when it cannot be embedded. */
    resolveImage(src: string): TfDocxImage | null;
    /** Origin relative Taskforce links (`/p/…`) are completed with. */
    linkBase?: string;
    /** Writes the note titles as headings (on by default). */
    titles?: boolean;
}

/** Content width of an A4 page with 2.54 cm margins, in twentieths of a point and in pixels. */
const CONTENT_WIDTH_TWIPS = 9026;
const CONTENT_WIDTH_PX = 600;
const MONO = "Consolas";
const CODE_SHADING = "F2F2F2";
const HEADINGS = [ HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6 ];
const BLOCK_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "PRE", "BLOCKQUOTE", "ASIDE", "FIGURE",
    "DIV", "SECTION", "HR", "DETAILS", "SUMMARY", "FIGCAPTION", "HEADER", "FOOTER", "ARTICLE", "NAV", "DL", "DT", "DD"
]);
const ADMONITION_LABELS: Record<string, string> = { note: "Note", tip: "Tip", important: "Important", caution: "Caution", warning: "Warning" };

type Block = Paragraph | Table;

interface Format {
    bold?: boolean;
    italics?: boolean;
    underline?: boolean;
    strike?: boolean;
    code?: boolean;
    superScript?: boolean;
    subScript?: boolean;
    highlight?: boolean;
    link?: string;
}

interface BlockStyle {
    /** Extra paragraph options (indent, border, shading) of a quote or admonition around the content. */
    paragraph?: Partial<IParagraphOptions>;
    /** Heading levels move down by this much inside a child note. */
    headingShift: number;
    /** Run formatting of everything inside, such as bold text in a header cell. */
    run?: Format;
}

/** Builds the .docx file for `source`. */
export async function buildTfDocx(source: TfDocxSource, options: TfDocxOptions): Promise<Uint8Array> {
    const writer = new DocxWriter(options);
    const children: Block[] = [];
    const withTitles = options.titles !== false;

    for (const [ position, note ] of source.notes.entries()) {
        if (position > 0) {
            children.push(new Paragraph({ children: [ new PageBreak() ] }));
        }
        if (withTitles) {
            children.push(new Paragraph({ heading: HEADINGS[Math.min(note.level, 5)], children: [ new TextRun(note.title) ] }));
        }
        const root = parse(note.html, { comment: false, blockTextElements: { script: true, style: true, noscript: true } });
        writer.collectFootnotes(root);
        children.push(...writer.blocks(root.childNodes, { headingShift: withTitles ? note.level : 0 }));
    }

    if (!children.length) {
        children.push(new Paragraph({}));
    }

    const document = new Document({
        creator: "NoteForce",
        title: source.title,
        styles: {
            default: {
                document: { run: { font: "Calibri", size: 22 }, paragraph: { spacing: { after: 120, line: 276 } } }
            }
        },
        numbering: { config: writer.numberingConfig() },
        footnotes: writer.footnotes(),
        sections: [ {
            properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
            children
        } ]
    });
    return new Uint8Array(await Packer.toBuffer(document));
}

class DocxWriter {
    private readonly lists: { reference: string; ordered: boolean; start: number }[] = [];
    private readonly footnoteIds = new Map<string, number>();
    private readonly footnoteBodies = new Map<number, Paragraph[]>();

    constructor(private readonly options: TfDocxOptions) {}

    numberingConfig() {
        const config = [ { reference: "tf-bullet", levels: bulletLevels() } ];
        for (const list of this.lists) {
            if (list.ordered) {
                config.push({ reference: list.reference, levels: orderedLevels(list.start) });
            }
        }
        return config;
    }

    footnotes() {
        const result: Record<string, { children: Paragraph[] }> = {};
        for (const [ id, children ] of this.footnoteBodies) {
            result[String(id)] = { children: children.length ? children : [ new Paragraph({}) ] };
        }
        return result;
    }

    /** Reads the footnote section of a note first, so the references in its text can be numbered. */
    collectFootnotes(root: HTMLElement) {
        for (const item of root.querySelectorAll("li.footnote-item, li[data-footnote-item]")) {
            const id = item.getAttribute("data-footnote-id");
            if (!id || this.footnoteIds.has(id)) {
                continue;
            }
            const number = this.footnoteIds.size + 1;
            this.footnoteIds.set(id, number);
            const content = item.querySelector(".footnote-content, [data-footnote-content]") ?? item;
            const paragraphs = this.blocks(content.childNodes, { headingShift: 0 })
                .filter((block): block is Paragraph => block instanceof Paragraph);
            this.footnoteBodies.set(number, paragraphs);
        }
    }

    blocks(nodes: Node[], style: BlockStyle): Block[] {
        const out: Block[] = [];
        let inline: ParagraphChild[] = [];
        const flush = () => {
            if (inline.length) {
                out.push(new Paragraph({ ...style.paragraph, children: inline }));
                inline = [];
            }
        };

        for (const node of nodes) {
            if (node.nodeType === NodeType.TEXT_NODE) {
                const text = collapse(node.text);
                if (text.trim() || inline.length) {
                    inline.push(...this.textRuns(text, style.run ?? {}));
                }
                continue;
            }
            if (!isElement(node)) {
                continue;
            }
            if (isBlock(node) || isImageFigure(node)) {
                flush();
                out.push(...this.block(node, style));
            } else {
                inline.push(...this.inline(node, style.run ?? {}));
            }
        }
        flush();
        return out;
    }

    private block(element: HTMLElement, style: BlockStyle): Block[] {
        const tag = element.tagName;
        const classes = element.classList;

        if (classes.contains("footnote-section") || element.hasAttribute("data-footnote-section")) {
            return [];
        }
        if (classes.contains("page-break")) {
            return [ new Paragraph({ children: [ new PageBreak() ] }) ];
        }
        if (/^H[1-6]$/.test(tag)) {
            const level = Math.min(Number(tag.slice(1)) - 1 + style.headingShift, 5);
            return [ new Paragraph({ ...style.paragraph, heading: HEADINGS[Math.max(level, 1)], children: this.inlineChildren(element, style.run ?? {}) }) ];
        }
        switch (tag) {
            case "P":
                return [ new Paragraph({ ...style.paragraph, alignment: alignmentOf(element), children: this.inlineChildren(element, style.run ?? {}) }) ];
            case "UL":
            case "OL":
                return this.list(element, style, 0);
            case "TABLE":
                return [ this.table(element) ];
            case "PRE":
                return [ this.codeBlock(element, style) ];
            case "HR":
                return [ new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] }) ];
            case "BLOCKQUOTE":
                return this.blocks(element.childNodes, {
                    ...style,
                    paragraph: { ...style.paragraph, indent: { left: 567 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "BBBBBB", space: 8 } } }
                });
            case "ASIDE":
                return classes.contains("admonition") ? this.admonition(element, style) : this.blocks(element.childNodes, style);
            case "FIGURE":
                return this.figure(element, style);
            default:
                return this.blocks(element.childNodes, style);
        }
    }

    private figure(element: HTMLElement, style: BlockStyle): Block[] {
        if (element.classList.contains("table")) {
            const table = element.querySelector("table");
            const caption = element.querySelector("figcaption");
            const blocks: Block[] = table ? [ this.table(table) ] : [];
            if (caption) {
                blocks.push(new Paragraph({ children: this.inlineChildren(caption, { italics: true }) }));
            }
            return blocks;
        }
        if (element.classList.contains("image") || element.querySelector("img")) {
            const img = element.querySelector("img");
            const blocks: Block[] = [];
            if (img) {
                blocks.push(new Paragraph({ ...style.paragraph, alignment: AlignmentType.CENTER, children: this.image(img, element) }));
            }
            const caption = element.querySelector("figcaption");
            if (caption) {
                blocks.push(new Paragraph({ alignment: AlignmentType.CENTER, children: this.inlineChildren(caption, { italics: true }) }));
            }
            return blocks;
        }
        return this.blocks(element.childNodes, style);
    }

    private admonition(element: HTMLElement, style: BlockStyle): Block[] {
        const type = [ ...element.classList.values() ].find((name) => name in ADMONITION_LABELS) ?? "note";
        const border = { style: BorderStyle.SINGLE, size: 8, color: "8C8C8C", space: 6 };
        const paragraph: Partial<IParagraphOptions> = {
            ...style.paragraph,
            border: { top: border, bottom: border, left: border, right: border },
            indent: { left: 170, right: 170 }
        };
        const inner = this.blocks(element.childNodes, { ...style, paragraph });
        const lead = new TextRun({ text: `${ADMONITION_LABELS[type]}: `, bold: true });
        const first = inner[0];
        if (first instanceof Paragraph) {
            const firstNode = firstBlockOf(element);
            const rest = inner.slice(1);
            const runs = firstNode ? this.inlineChildren(firstNode, {}) : [];
            return [ new Paragraph({ ...paragraph, children: [ lead, ...runs ] }), ...rest ];
        }
        return [ new Paragraph({ ...paragraph, children: [ lead ] }), ...inner ];
    }

    private list(element: HTMLElement, style: BlockStyle, level: number): Block[] {
        const ordered = element.tagName === "OL";
        const todo = element.classList.contains("todo-list");
        let reference = "tf-bullet";
        if (ordered) {
            reference = `tf-ol-${this.lists.length + 1}`;
            const start = Number.parseInt(element.getAttribute("start") ?? "1", 10);
            this.lists.push({ reference, ordered: true, start: Number.isFinite(start) ? start : 1 });
        }

        const out: Block[] = [];
        for (const item of element.childNodes) {
            if (!isElement(item) || item.tagName !== "LI") {
                continue;
            }
            const own: Node[] = [];
            const nested: HTMLElement[] = [];
            for (const child of item.childNodes) {
                if (isElement(child) && (child.tagName === "UL" || child.tagName === "OL")) {
                    nested.push(child);
                } else {
                    own.push(child);
                }
            }

            const lead: ParagraphChild[] = [];
            if (todo) {
                const box = item.querySelector("input[type=checkbox]");
                lead.push(new TextRun({ text: box?.hasAttribute("checked") ? "☑ " : "☐ " }));
            }
            const listed: Partial<IParagraphOptions> = todo
                ? { indent: { left: 360 * (level + 1), hanging: 360 } }
                : { numbering: { reference, level: Math.min(level, 8) } };

            const blocks = this.blocks(own.filter((node) => !isCheckbox(node)), style);
            const [ first, ...rest ] = blocks;
            if (first instanceof Paragraph || !first) {
                const runs = this.listItemRuns(own);
                out.push(new Paragraph({ ...style.paragraph, ...listed, children: [ ...lead, ...runs ] }));
                const continued = this.blocks(own.filter((node) => !isCheckbox(node)), {
                    ...style, paragraph: { ...style.paragraph, indent: { left: 720 * (level + 1) } }
                }).slice(1);
                out.push(...(rest.length ? continued : []));
            } else {
                out.push(new Paragraph({ ...style.paragraph, ...listed, children: lead }), ...blocks);
            }

            for (const list of nested) {
                out.push(...this.list(list, style, level + 1));
            }
        }
        return out;
    }

    /** The runs of a list item's first line: its text, or the inline content of its first block. */
    private listItemRuns(nodes: Node[]): ParagraphChild[] {
        const runs: ParagraphChild[] = [];
        for (const node of nodes) {
            if (node.nodeType === NodeType.TEXT_NODE) {
                const text = collapse(node.text);
                if (text.trim() || runs.length) {
                    runs.push(...this.textRuns(text, {}));
                }
                continue;
            }
            if (!isElement(node) || isCheckbox(node)) {
                continue;
            }
            if (node.tagName === "LABEL") {
                runs.push(...this.listItemRuns(node.childNodes));
            } else if (isBlock(node)) {
                if (!runs.length) {
                    runs.push(...this.inlineChildren(node, {}));
                }
                break;
            } else {
                runs.push(...this.inline(node, {}));
            }
        }
        return runs;
    }

    private table(element: HTMLElement): Table {
        const rows: HTMLElement[] = element.querySelectorAll("tr")
            .filter((row) => row.closest("table") === element);
        const headRows = new Set(element.querySelectorAll("thead tr").filter((row) => row.closest("table") === element));

        let columns = 1;
        for (const row of rows) {
            const width = cellsOf(row).reduce((sum, cell) => sum + span(cell, "colspan"), 0);
            columns = Math.max(columns, width);
        }
        const columnWidth = Math.floor(CONTENT_WIDTH_TWIPS / columns);

        const tableRows = rows.map((row) => {
            const cells = cellsOf(row);
            const isHeader = headRows.has(row) || (cells.length > 0 && cells.every((cell) => cell.tagName === "TH"));
            return new TableRow({
                tableHeader: isHeader,
                children: cells.map((cell) => {
                    const header = isHeader || cell.tagName === "TH";
                    const content = this.blocks(cell.childNodes, { headingShift: 0, run: header ? { bold: true } : undefined });
                    const children = content.length ? content : [ new Paragraph({}) ];
                    const colspan = span(cell, "colspan");
                    return new TableCell({
                        children,
                        columnSpan: colspan > 1 ? colspan : undefined,
                        rowSpan: span(cell, "rowspan") > 1 ? span(cell, "rowspan") : undefined,
                        width: { size: columnWidth * colspan, type: WidthType.DXA },
                        shading: header ? { type: ShadingType.CLEAR, fill: "EDEDED", color: "auto" } : undefined
                    });
                })
            });
        });

        return new Table({
            rows: tableRows.length ? tableRows : [ new TableRow({ children: [ new TableCell({ children: [ new Paragraph({}) ] }) ] }) ],
            width: { size: CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
            columnWidths: Array.from({ length: columns }, () => columnWidth)
        });
    }

    private codeBlock(element: HTMLElement, style: BlockStyle): Paragraph {
        const code = element.querySelector("code") ?? element;
        const lines = code.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
        const runs = lines.map((line, index) => new TextRun({ text: line, font: MONO, size: 20, break: index > 0 ? 1 : undefined }));
        return new Paragraph({
            ...style.paragraph,
            shading: { type: ShadingType.CLEAR, fill: CODE_SHADING, color: "auto" },
            border: {
                top: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD", space: 4 },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD", space: 4 },
                left: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD", space: 4 },
                right: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD", space: 4 }
            },
            children: runs
        });
    }

    inlineChildren(element: HTMLElement, format: Format): ParagraphChild[] {
        const runs: ParagraphChild[] = [];
        for (const child of element.childNodes) {
            if (child.nodeType === NodeType.TEXT_NODE) {
                runs.push(...this.textRuns(collapse(child.text), format));
            } else if (isElement(child)) {
                runs.push(...this.inline(child, format));
            }
        }
        return runs;
    }

    private inline(element: HTMLElement, format: Format): ParagraphChild[] {
        const tag = element.tagName;
        const classes = element.classList;

        if (classes.contains("footnote-reference") || element.hasAttribute("data-footnote-reference")) {
            const number = this.footnoteIds.get(element.getAttribute("data-footnote-id") ?? "");
            return number ? [ new FootnoteReferenceRun(number) ] : [];
        }
        if (classes.contains("math-tex")) {
            const source = element.text.trim().replace(/^\\[([]/, "").replace(/\\[)\]]$/, "").trim();
            return [ new TextRun({ text: source, font: "Cambria Math", italics: true }) ];
        }
        switch (tag) {
            case "BR":
                return [ new TextRun({ text: "", break: 1 }) ];
            case "IMG":
                return this.image(element, null);
            case "INPUT":
                return element.getAttribute("type") === "checkbox"
                    ? [ new TextRun({ text: element.hasAttribute("checked") ? "☑ " : "☐ " }) ]
                    : [];
            case "STRONG":
            case "B":
                return this.inlineChildren(element, { ...format, bold: true });
            case "EM":
            case "I":
                return this.inlineChildren(element, { ...format, italics: true });
            case "U":
                return this.inlineChildren(element, { ...format, underline: true });
            case "S":
            case "DEL":
            case "STRIKE":
                return this.inlineChildren(element, { ...format, strike: true });
            case "CODE":
            case "KBD":
            case "SAMP":
                return this.inlineChildren(element, { ...format, code: true });
            case "SUP":
                return this.inlineChildren(element, { ...format, superScript: true });
            case "SUB":
                return this.inlineChildren(element, { ...format, subScript: true });
            case "MARK":
                return this.inlineChildren(element, { ...format, highlight: true });
            case "A":
                return this.link(element, format);
            default:
                return this.inlineChildren(element, format);
        }
    }

    private link(element: HTMLElement, format: Format): ParagraphChild[] {
        const href = element.getAttribute("href") ?? "";
        const target = this.absoluteLink(href);
        if (!target) {
            return this.inlineChildren(element, format);
        }
        const runs = this.inlineChildren(element, { ...format, link: target });
        if (!runs.length) {
            return [];
        }
        return [ new ExternalHyperlink({ link: target, children: runs }) ];
    }

    private absoluteLink(href: string): string | null {
        if (/^(https?:|mailto:|tel:)/i.test(href)) {
            return href;
        }
        if (href.startsWith("/") && !href.startsWith("//") && this.options.linkBase) {
            return `${this.options.linkBase.replace(/\/$/, "")}${href}`;
        }
        return null;
    }

    private textRuns(text: string, format: Format): ParagraphChild[] {
        if (!text) {
            return [];
        }
        const options: IRunOptions = {
            text,
            bold: format.bold,
            italics: format.italics,
            underline: format.underline || format.link ? {} : undefined,
            strike: format.strike,
            superScript: format.superScript,
            subScript: format.subScript,
            font: format.code ? MONO : undefined,
            shading: format.code ? { type: ShadingType.CLEAR, fill: CODE_SHADING, color: "auto" } : undefined,
            highlight: format.highlight ? "yellow" : undefined,
            color: format.link ? "0563C1" : undefined
        };
        return [ new TextRun(options) ];
    }

    private image(img: HTMLElement, figure: HTMLElement | null): ParagraphChild[] {
        const src = img.getAttribute("src") ?? "";
        const alt = img.getAttribute("alt") ?? "";
        const resolved = src ? this.options.resolveImage(src) : null;
        const type = resolved ? imageType(resolved.mime, resolved.data) : null;
        if (!resolved || !type) {
            return alt ? [ new TextRun({ text: `[${alt}]`, italics: true }) ] : [];
        }
        const natural = imageSize(resolved.data) ?? { width: CONTENT_WIDTH_PX, height: Math.round(CONTENT_WIDTH_PX * 0.66) };
        const wanted = requestedWidth(img, figure, natural.width);
        const width = Math.max(1, Math.min(wanted, CONTENT_WIDTH_PX));
        const height = Math.max(1, Math.round(natural.height * width / natural.width));
        return [ new ImageRun({ type, data: resolved.data, transformation: { width, height }, altText: alt ? { name: alt, description: alt, title: alt } : undefined }) ];
    }
}

function bulletLevels(): ILevelsOptions[] {
    const glyphs = [ "•", "◦", "▪" ];
    return Array.from({ length: 9 }, (_, level) => ({
        level,
        format: LevelFormat.BULLET,
        text: glyphs[level % 3],
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
    }));
}

function orderedLevels(start: number): ILevelsOptions[] {
    const formats = [ LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN ];
    return Array.from({ length: 9 }, (_, level) => ({
        level,
        format: formats[level % 3],
        text: `%${level + 1}.`,
        start: level === 0 ? start : 1,
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
    }));
}

function isElement(node: Node): node is HTMLElement {
    return node.nodeType === NodeType.ELEMENT_NODE;
}

function isBlock(element: HTMLElement) {
    return BLOCK_TAGS.has(element.tagName);
}

function isImageFigure(element: HTMLElement) {
    return element.tagName === "IMG" && element.parentNode?.tagName !== "P";
}

function isCheckbox(node: Node) {
    return isElement(node) && node.tagName === "INPUT" && node.getAttribute("type") === "checkbox";
}

function firstBlockOf(element: HTMLElement): HTMLElement | null {
    for (const child of element.childNodes) {
        if (isElement(child) && isBlock(child)) {
            return child.tagName === "P" ? child : null;
        }
    }
    return null;
}

function cellsOf(row: HTMLElement) {
    return row.childNodes.filter((cell): cell is HTMLElement => isElement(cell) && (cell.tagName === "TD" || cell.tagName === "TH"));
}

function span(cell: HTMLElement, name: "colspan" | "rowspan") {
    const value = Number.parseInt(cell.getAttribute(name) ?? "1", 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 63) : 1;
}

function alignmentOf(element: HTMLElement) {
    const style = element.getAttribute("style") ?? "";
    const match = /text-align\s*:\s*(left|right|center|justify)/i.exec(style);
    switch (match?.[1]?.toLowerCase()) {
        case "center": return AlignmentType.CENTER;
        case "right": return AlignmentType.RIGHT;
        case "justify": return AlignmentType.JUSTIFIED;
        default: return undefined;
    }
}

function collapse(text: string) {
    return text.replace(/[\t\n\r ]+/g, " ");
}

function requestedWidth(img: HTMLElement, figure: HTMLElement | null, natural: number) {
    const fromAttr = Number.parseInt(img.getAttribute("width") ?? "", 10);
    if (Number.isFinite(fromAttr) && fromAttr > 0) {
        return fromAttr;
    }
    const style = `${figure?.getAttribute("style") ?? ""};${img.getAttribute("style") ?? ""}`;
    const px = /(?:^|;)\s*width\s*:\s*([\d.]+)px/i.exec(style);
    if (px) {
        return Number(px[1]);
    }
    const percent = /(?:^|;)\s*width\s*:\s*([\d.]+)%/i.exec(style);
    if (percent) {
        return Math.round(CONTENT_WIDTH_PX * Number(percent[1]) / 100);
    }
    return natural;
}

function imageType(mime: string, data: Uint8Array): "png" | "jpg" | "gif" | "bmp" | null {
    if (data[0] === 0x89 && data[1] === 0x50) return "png";
    if (data[0] === 0xff && data[1] === 0xd8) return "jpg";
    if (data[0] === 0x47 && data[1] === 0x49) return "gif";
    if (data[0] === 0x42 && data[1] === 0x4d) return "bmp";
    return mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : null;
}

/** Pixel size from the file header of a PNG, GIF, BMP or JPEG. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50) {
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (data.length > 10 && data[0] === 0x47 && data[1] === 0x49) {
        return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (data.length > 26 && data[0] === 0x42 && data[1] === 0x4d) {
        return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
    }
    if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < data.length) {
            if (data[offset] !== 0xff) {
                offset++;
                continue;
            }
            const marker = data[offset + 1];
            const length = view.getUint16(offset + 2);
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
            }
            offset += 2 + length;
        }
    }
    return null;
}
