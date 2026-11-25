/**
 * NoteForce work features inside the text editor: live Taskforce chips, a pasted Taskforce link
 * turned into one, the to-do item a task was made from ticking with the task, and the "Make task"
 * and "Remind me" toolbar buttons.
 *
 * Inert without the `tfWork` config, which the client sets only while the notebook runs embedded
 * in Taskforce: no schema, converters or listeners are added, so the editor behaves like upstream.
 *
 * A chip is stored as an ordinary link, `<a class="tf-chip" href data-tf-kind data-tf-id>title</a>`,
 * which every other reader of the HTML (exports, share pages, an upstream client) shows as a link.
 */
import {
    ButtonView, type Editor, type ModelElement, Plugin, toWidget, type UpcastElementEvent,
    type ViewDocumentClipboardInputEvent, type ViewElement
} from "ckeditor5";

import { assignBlockId } from "../../plugins/block_reference/block_reference_editing.js";

export const TF_CHIP = "tfChip";
export const TF_CHIP_CLASS = "tf-chip";

export type TfChipKind = "task" | "project" | "document" | "note";

/** What a chip element holds. */
export interface TfChipData {
    href: string;
    kind: TfChipKind;
    id: string;
    /** The title the saved HTML carries. */
    storedTitle: string;
}

/** What the editor hands the host for a block the caret or the selection is in. */
export interface TfBlockContext {
    blockId: string;
    /** The selected text, or the block's text without its chips; whitespace collapsed. */
    text: string;
    isTodo: boolean;
    checked: boolean;
}

/** Actions on one chip that only the editor can carry out. */
export interface TfChipActions {
    turnIntoLink(): void;
    readonly isEditable: boolean;
}

/** The client's side of the plugin (`editor.config.get("tfWork")`). */
export interface TfWorkHost {
    /** What a pasted text points at when it is a Taskforce link, else `null`. */
    parseLink(text: string): { kind: TfChipKind; id: string; href: string } | null;
    /** Draws the chip's inside into `dom` and keeps it current; called again on each redraw. */
    renderChip(dom: HTMLElement, data: TfChipData, actions: TfChipActions): void;
    /** The latest known title of a chip, written into the saved HTML. */
    chipTitle(data: TfChipData): string;
    /** A chip was added to the document (paste or a new task), so it can be resolved. */
    chipAdded?(data: TfChipData): void;
    /** A to-do item carrying a task chip was ticked or unticked in this editor. */
    linkedTodoChanged?(taskId: string, checked: boolean): void;
    /** The editor is ready; the returned function runs when it is destroyed. */
    attach?(editor: Editor): (() => void) | void;
    makeTask?(editor: Editor): void;
    remind?(editor: Editor): void;
    /** Labels of the toolbar buttons. */
    label(key: "makeTask" | "remindMe"): string;
}

declare module "ckeditor5" {
    interface EditorConfig {
        tfWork?: TfWorkHost;
    }
    interface PluginsMap {
        [TfWork.pluginName]: TfWork;
    }
}

const TASK_ICON = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 20 20\"><path d=\"M4 3h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v10h10V5H5zm7.8 2.3 1.4 1.4-5 5-3-3 1.4-1.4 1.6 1.6 3.6-3.6z\"/></svg>";
const BELL_ICON = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 20 20\"><path d=\"M10 2a5 5 0 0 1 5 5v3.6l1.7 2.9a1 1 0 0 1-.9 1.5H4.2a1 1 0 0 1-.9-1.5L5 10.6V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v4.1L5.9 13h8.2L13 11.1V7a3 3 0 0 0-3-3zM8 16h4a2 2 0 0 1-4 0z\"/></svg>";

const TODO_CHECKED = "todoListChecked";
const TASK_STATE = "taskState";
/** On the text of a link that was stored as a chip but is not one: saved with `rel="noopener noreferrer"`. */
const SAFE_LINK = "tfSafeLink";

export default class TfWork extends Plugin {
    static get pluginName() {
        return "TfWork" as const;
    }

    /** Set while the editor applies a task's state to its to-do item, so that change is not sent back. */
    private applyingRemote = false;

    private detachHost: (() => void) | null = null;

    get host(): TfWorkHost | undefined {
        return this.editor.config.get("tfWork");
    }

    init() {
        const host = this.host;
        if (!host) {
            return;
        }
        this.defineSchema();
        this.defineConverters(host);
        this.listenToPaste(host);
        this.listenToLinkedTodos(host);
        this.addButtons(host);
    }

    afterInit() {
        const detach = this.host?.attach?.(this.editor);
        if (detach) {
            this.detachHost = detach;
        }
    }

    override destroy() {
        this.detachHost?.();
        this.detachHost = null;
        super.destroy();
    }

    /** Every chip in the document. */
    getChips(): { element: ModelElement; data: TfChipData }[] {
        const result: { element: ModelElement; data: TfChipData }[] = [];
        for (const root of this.editor.model.document.getRoots()) {
            for (const { item } of this.editor.model.createRangeIn(root)) {
                if (item.is("element", TF_CHIP)) {
                    result.push({ element: item, data: chipData(item) });
                }
            }
        }
        return result;
    }

    /** Draws the chips again from what the host knows, without touching the document. */
    redrawChips(filter?: (data: TfChipData) => boolean) {
        for (const { element, data } of this.getChips()) {
            if (!filter || filter(data)) {
                this.editor.editing.reconvertItem(element);
            }
        }
    }

    /**
     * The block holding the caret (or the start of the selection), with an id given to it now if it
     * had none, or `null` outside a block.
     */
    getBlockContext(target?: ModelElement | null): TfBlockContext | null {
        const model = this.editor.model;
        const selection = model.document.selection;
        const position = selection.getFirstPosition();
        const block = target ?? (position ? findBlock(position.parent as ModelElement) : null);
        if (!block) {
            return null;
        }
        let text = "";
        if (!target && !selection.isCollapsed) {
            for (const range of selection.getRanges()) {
                for (const { item } of range.getWalker()) {
                    if (item.is("$textProxy")) {
                        text += item.data;
                    }
                }
                text += " ";
            }
        }
        text = collapse(text) || blockText(block);
        return {
            blockId: assignBlockId(model, block),
            text,
            isTodo: block.getAttribute("listType") === "todo",
            checked: block.getAttribute(TODO_CHECKED) === true
        };
    }

    /** The block a DOM node of the editing view belongs to, or `null`. */
    blockForDom(node: Node): ModelElement | null {
        const editing = this.editor.editing;
        let current: Node | null = node;
        while (current && current !== editing.view.getDomRoot()) {
            const viewNode = editing.view.domConverter.mapDomToView(current as HTMLElement);
            if (viewNode?.is("element")) {
                const modelElement = editing.mapper.toModelElement(viewNode);
                const block = modelElement ? findBlock(modelElement) : null;
                if (block) {
                    return block;
                }
            }
            current = current.parentNode;
        }
        return null;
    }

    /** The DOM element the editing view draws `block` as. */
    domForBlock(block: ModelElement): HTMLElement | null {
        const editing = this.editor.editing;
        const viewElement = editing.mapper.toViewElement(block);
        const dom = viewElement ? editing.view.domConverter.mapViewToDom(viewElement) : null;
        return dom instanceof HTMLElement ? dom : null;
    }

    /** The to-do items of the document with their block id (if any) and whether they carry a task chip. */
    getTodoBlocks(): { block: ModelElement; blockId: string | null; taskIds: string[] }[] {
        const result: { block: ModelElement; blockId: string | null; taskIds: string[] }[] = [];
        for (const root of this.editor.model.document.getRoots()) {
            for (const { item } of this.editor.model.createRangeIn(root)) {
                if (!item.is("element") || item.getAttribute("listType") !== "todo" || !this.editor.model.schema.isBlock(item)) {
                    continue;
                }
                const taskIds: string[] = [];
                for (const child of item.getChildren()) {
                    if (child.is("element", TF_CHIP) && child.getAttribute("tfChipKind") === "task") {
                        taskIds.push(String(child.getAttribute("tfChipId")));
                    }
                }
                const blockId = item.getAttribute("blockId");
                result.push({ block: item, blockId: typeof blockId === "string" ? blockId : null, taskIds });
            }
        }
        return result;
    }

    /** Adds a chip at the end of the block `blockId` (a space before it). */
    appendChip(blockId: string, data: TfChipData) {
        const block = this.findBlockById(blockId);
        if (!block) {
            return false;
        }
        this.editor.model.change((writer) => {
            const end = writer.createPositionAt(block, "end");
            const last = block.getChild(block.childCount - 1);
            const needsSpace = !!last && !(last.is("$text") && last.data.endsWith(" "));
            if (needsSpace) {
                writer.insertText(" ", end);
            }
            writer.insert(writer.createElement(TF_CHIP, chipAttributes(data)), writer.createPositionAt(block, "end"));
        });
        this.host?.chipAdded?.(data);
        return true;
    }

    /**
     * Ticks or unticks the to-do items that carry a chip of task `taskId`, as one normal edit.
     * Returns whether anything changed.
     */
    setTaskTodoState(taskId: string, done: boolean): boolean {
        const blocks = this.getChips()
            .filter(({ data }) => data.kind === "task" && data.id === taskId)
            .map(({ element }) => element.parent)
            .filter((parent): parent is ModelElement => !!parent && parent.is("element") && parent.getAttribute("listType") === "todo")
            .filter((block) => (block.getAttribute(TODO_CHECKED) === true) !== done);
        if (!blocks.length || this.editor.isReadOnly) {
            return false;
        }
        this.applyingRemote = true;
        try {
            this.editor.model.change((writer) => {
                for (const block of blocks) {
                    if (done) {
                        writer.setAttribute(TODO_CHECKED, true, block);
                    } else {
                        writer.removeAttribute(TODO_CHECKED, block);
                    }
                    if (block.hasAttribute(TASK_STATE)) {
                        writer.removeAttribute(TASK_STATE, block);
                    }
                }
            });
        } finally {
            this.applyingRemote = false;
        }
        return true;
    }

    findBlockById(blockId: string): ModelElement | null {
        for (const root of this.editor.model.document.getRoots()) {
            for (const { item } of this.editor.model.createRangeIn(root)) {
                if (item.is("element") && item.getAttribute("blockId") === blockId) {
                    return item;
                }
            }
        }
        return null;
    }

    private defineSchema() {
        this.editor.model.schema.register(TF_CHIP, {
            allowWhere: "$text",
            isInline: true,
            isObject: true,
            allowAttributes: [ "tfChipHref", "tfChipKind", "tfChipId", "tfChipTitle" ]
        });
        this.editor.model.schema.extend("$text", { allowAttributes: SAFE_LINK });
    }

    private defineConverters(host: TfWorkHost) {
        const editor = this.editor;
        const conversion = editor.conversion;

        conversion.for("upcast").elementToElement({
            view: { name: "a", classes: TF_CHIP_CLASS, attributes: { href: true } },
            model: (viewElement, { writer, consumable }) => {
                const kind = viewElement.getAttribute("data-tf-kind");
                const id = viewElement.getAttribute("data-tf-id");
                const href = String(viewElement.getAttribute("href") ?? "");
                if (!isKind(kind) || !id || !isGenuineChip(host, href, kind, id)) {
                    // Pasted or forged HTML: no chip. A web link stays a link (marked to be saved
                    // with `rel`), anything else (`javascript:`, `data:`) becomes its plain text.
                    consumable.consume(viewElement, {
                        classes: [ TF_CHIP_CLASS ],
                        attributes: [ "data-tf-kind", "data-tf-id" ].filter((name) => viewElement.hasAttribute(name))
                    });
                    if (!isWebLink(href)) {
                        consumable.consume(viewElement, { attributes: [ "href" ] });
                    }
                    return null;
                }
                consumable.consume(viewElement, { attributes: [ "data-tf-kind", "data-tf-id" ] });
                return writer.createElement(TF_CHIP, chipAttributes({
                    href,
                    kind,
                    id,
                    storedTitle: textOf(viewElement)
                }));
            },
            converterPriority: "highest"
        });

        conversion.for("upcast").add((dispatcher) => {
            dispatcher.on<UpcastElementEvent>("element:a", (_event, data, { writer }) => {
                const viewElement = data.viewItem;
                if (!viewElement.hasClass(TF_CHIP_CLASS) || !data.modelRange || !isWebLink(String(viewElement.getAttribute("href") ?? ""))) {
                    return;
                }
                for (const item of data.modelRange.getItems()) {
                    if (item.is("$textProxy") && item.hasAttribute("linkHref")) {
                        writer.setAttribute(SAFE_LINK, true, item);
                    }
                }
            }, { priority: "lowest" });
        });

        conversion.for("downcast").attributeToElement({
            model: SAFE_LINK,
            view: (value, { writer }) => value ? writer.createAttributeElement("a", { rel: "noopener noreferrer" }, { priority: 5 }) : null
        });

        // The mark goes with the link: unlinking the text leaves no `rel` behind.
        editor.model.document.registerPostFixer((writer) => {
            let changed = false;
            for (const change of editor.model.document.differ.getChanges()) {
                if (change.type === "attribute" && change.attributeKey === "linkHref" && change.attributeNewValue == null) {
                    for (const item of change.range.getItems()) {
                        if (item.hasAttribute(SAFE_LINK)) {
                            writer.removeAttribute(SAFE_LINK, item);
                            changed = true;
                        }
                    }
                }
            }
            return changed;
        });

        conversion.for("editingDowncast").elementToElement({
            model: TF_CHIP,
            view: (modelItem, { writer }) => {
                const data = chipData(modelItem);
                const container = writer.createContainerElement("span", {
                    class: `${TF_CHIP_CLASS} ${TF_CHIP_CLASS}--${data.kind}`,
                    "data-tf-kind": data.kind,
                    "data-tf-id": data.id,
                    "data-tf-href": data.href
                });
                const actions: TfChipActions = {
                    turnIntoLink: () => this.turnIntoLink(modelItem),
                    get isEditable() {
                        return !editor.isReadOnly;
                    }
                };
                const inner = writer.createUIElement("span", { class: "tf-chip__body" }, function (domDocument) {
                    const dom = this.toDomElement(domDocument);
                    host.renderChip(dom, chipData(modelItem), actions);
                    return dom;
                });
                writer.insert(writer.createPositionAt(container, 0), inner);
                return toWidget(container, writer);
            }
        });

        conversion.for("dataDowncast").elementToElement({
            model: TF_CHIP,
            view: (modelItem, { writer }) => {
                const data = chipData(modelItem);
                const link = writer.createContainerElement("a", {
                    class: TF_CHIP_CLASS,
                    href: data.href,
                    "data-tf-kind": data.kind,
                    "data-tf-id": data.id
                });
                writer.insert(writer.createPositionAt(link, 0), writer.createText(host.chipTitle(data) || data.storedTitle || data.href));
                return link;
            }
        });
    }

    /**
     * A Taskforce link alone on the clipboard is pasted as a link first and turned into a chip in a
     * second undo step, so Cmd/Ctrl+Z gives the plain link back.
     */
    private listenToPaste(host: TfWorkHost) {
        const editor = this.editor;
        this.listenTo<ViewDocumentClipboardInputEvent>(editor.editing.view.document, "clipboardInput", (evt, data) => {
            if (data.method !== "paste" || !data.dataTransfer) {
                return;
            }
            const text = data.dataTransfer.getData("text/plain").trim();
            if (!text || /\s/.test(text)) {
                return;
            }
            const html = data.dataTransfer.getData("text/html");
            if (html && !isOnlyLinkTo(html, text)) {
                return;
            }
            const ref = host.parseLink(text);
            const selection = editor.model.document.selection;
            const position = selection.getFirstPosition();
            if (!ref || !position || !editor.model.canEditAt(selection) || !editor.model.schema.checkChild(position, TF_CHIP)) {
                return;
            }
            evt.stop();

            const linkRange = editor.model.change((writer) => editor.model.insertContent(writer.createText(text, { linkHref: text })));
            editor.model.enqueueChange({ isUndoable: true }, (writer) => {
                const chip = { href: ref.href, kind: ref.kind, id: ref.id, storedTitle: "" };
                const element = writer.createElement(TF_CHIP, chipAttributes(chip));
                editor.model.insertContent(element, linkRange);
                writer.setSelection(element, "after");
            });
            host.chipAdded?.({ href: ref.href, kind: ref.kind, id: ref.id, storedTitle: "" });
        }, { priority: "high" });
    }

    private listenToLinkedTodos(host: TfWorkHost) {
        const editor = this.editor;
        editor.model.document.on("change:data", () => {
            if (this.applyingRemote || !host.linkedTodoChanged) {
                return;
            }
            for (const change of editor.model.document.differ.getChanges()) {
                if (change.type !== "attribute" || change.attributeKey !== TODO_CHECKED) {
                    continue;
                }
                for (const { item } of change.range.getWalker({ shallow: true })) {
                    if (!item.is("element") || item.getAttribute("listType") !== "todo") {
                        continue;
                    }
                    for (const child of item.getChildren()) {
                        if (child.is("element", TF_CHIP) && child.getAttribute("tfChipKind") === "task") {
                            host.linkedTodoChanged(String(child.getAttribute("tfChipId")), change.attributeNewValue === true);
                        }
                    }
                }
            }
        });
    }

    private addButtons(host: TfWorkHost) {
        const editor = this.editor;
        const add = (name: string, label: string, icon: string, run: (() => void) | undefined) => {
            if (!run) {
                return;
            }
            editor.ui.componentFactory.add(name, (locale) => {
                const button = new ButtonView(locale);
                button.set({ label, icon, tooltip: true, withText: true });
                button.on("execute", () => run());
                return button;
            });
        };
        add("tfMakeTask", host.label("makeTask"), TASK_ICON, host.makeTask && (() => host.makeTask?.(editor)));
        add("tfRemindMe", host.label("remindMe"), BELL_ICON, host.remind && (() => host.remind?.(editor)));
    }

    private turnIntoLink(element: ModelElement) {
        const editor = this.editor;
        if (editor.isReadOnly || element.root.rootName === "$graveyard") {
            return;
        }
        const data = chipData(element);
        const title = this.host?.chipTitle(data) || data.storedTitle || data.href;
        editor.model.change((writer) => {
            const position = writer.createPositionBefore(element);
            writer.insertText(title, { linkHref: data.href }, position);
            writer.remove(element);
        });
    }
}

function chipAttributes(data: TfChipData) {
    return { tfChipHref: data.href, tfChipKind: data.kind, tfChipId: data.id, tfChipTitle: data.storedTitle };
}

function chipData(element: ModelElement): TfChipData {
    return {
        href: String(element.getAttribute("tfChipHref") ?? ""),
        kind: (element.getAttribute("tfChipKind") as TfChipKind | undefined) ?? "task",
        id: String(element.getAttribute("tfChipId") ?? ""),
        storedTitle: String(element.getAttribute("tfChipTitle") ?? "")
    };
}

function isKind(value: unknown): value is TfChipKind {
    return value === "task" || value === "project" || value === "document" || value === "note";
}

/**
 * Whether stored chip HTML is what its link says: `host.parseLink()` takes the link for a Taskforce
 * link (it answers only for those, on an allowed origin) of the stated kind and id.
 */
function isGenuineChip(host: TfWorkHost, href: string, kind: TfChipKind, id: string) {
    const ref = href ? host.parseLink(href) : null;
    if (!ref || ref.kind !== kind) {
        return false;
    }
    return ref.id === id || (kind !== "note" && ref.id.toLowerCase() === id.toLowerCase());
}

function isWebLink(href: string) {
    return /^https?:\/\//i.test(href.trim());
}

function textOf(element: ViewElement): string {
    let text = "";
    for (const child of element.getChildren()) {
        if (child.is("$text")) {
            text += child.data;
        } else if (child.is("element")) {
            text += textOf(child);
        }
    }
    return collapse(text);
}

function findBlock(element: ModelElement | null): ModelElement | null {
    let current: ModelElement | null = element;
    while (current && current.is("element")) {
        const schema = current.root.document?.model.schema;
        if (schema?.isBlock(current) && !schema.isObject(current)) {
            return current;
        }
        current = current.parent as ModelElement | null;
    }
    return null;
}

function blockText(block: ModelElement): string {
    let text = "";
    for (const child of block.getChildren()) {
        if (child.is("$text")) {
            text += child.data;
        }
    }
    return collapse(text);
}

function collapse(text: string) {
    return text.replace(/\s+/g, " ").trim();
}

/** Whether clipboard HTML is nothing but one link to `url` (what browsers put there for a copied address). */
function isOnlyLinkTo(html: string, url: string) {
    const stripped = html.replace(/<meta[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!stripped) {
        return true;
    }
    const match = /^(?:<(?:html|body|span)[^>]*>\s*)*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:\s*<\/(?:html|body|span)>)*$/i.exec(stripped);
    if (!match) {
        return stripped.replace(/<[^>]+>/g, "").trim() === url;
    }
    return match[1].replace(/&amp;/g, "&") === url;
}
