/**
 * The text editor's part of the team features, added through `config.extraPlugins` by the
 * `editorPlugins` hook:
 *
 * - a person mention, an inline object stored as
 *   `<span class="tf-mention" data-tf-person-id="…" data-tf-person-name="…">@Name</span>` (a `span`
 *   with `class` and `data-*`, which both sanitizers keep, and which reads as "@Name" in an export);
 *   in the editor it is a widget underlined in the person's presence colour;
 * - picking a person in the `@` list (`notePath` = `tf-person:<id>`) inserts one, in place of the
 *   reference link the `mention` command inserts for a note;
 * - `tfComment`, the "Comment" tile of the phone toolbar's insert menu.
 */
import { assignBlockId } from "@triliumnext/ckeditor5";
import {
    type Batch, ButtonView, type ClipboardInputTransformationEvent, ClipboardPipeline, type Editor, type ModelElement,
    type ModelRange, Plugin, toWidget, type ViewDocumentFragment, type ViewElement, viewToModelPositionOutsideModelElement,
    ViewUpcastWriter, Widget
} from "ckeditor5";

import { t } from "../../services/i18n.js";
import { TF_PERSON_PATH_PREFIX } from "./hooks.js";
import { setBlockIdAssigner } from "./actions.js";
import { findBlock } from "./editors.js";
import { MENTION_CLASS, MENTION_NAME_ATTRIBUTE, MENTION_PERSON_ATTRIBUTE, mentionLabel } from "./model.js";

const MODEL_NAME = "tfMention";
const COMMENT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M4 3h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 1.5a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h2.5v1.8l2.4-1.8H16a.5.5 0 0 0 .5-.5V5a.5.5 0 0 0-.5-.5H4zM6 7h8v1.5H6V7zm0 3h5v1.5H6V10z"/></svg>`;

export interface TfTeamEditorHost {
    /** The person with `id`, for the name and colour of a new mention. */
    person(id: string): { id: string; name: string; color?: string } | undefined;
    /** Whether `id` may open this notebook; `null` while the people are not loaded yet. */
    isMember(id: string): boolean | null;
    /** Calls `listener` whenever the people list changed; returns the unsubscribe function. */
    subscribePeople(listener: () => void): () => void;
    /** `editor` holds new content from `setData()`: the note opened or reloaded. */
    contentLoaded(editor: Editor): void;
    /** A change of `editor`'s model (`change:data`). */
    modelChanged(editor: Editor, batch: Batch): void;
    /** Starts a comment thread on the block holding the selection of `editor`. */
    startComment(editor: Editor): void;
    /** Whether this person may write comments. */
    canComment(): boolean;
}

/** Builds the plugin class bound to `host`. */
export function createTeamEditorPlugin(host: TfTeamEditorHost): typeof Plugin {
    setBlockIdAssigner((editor, block) => assignBlockId(editor.model, block));

    return class TfTeamEditing extends Plugin {
        static get pluginName() {
            return "TfTeamEditing" as const;
        }

        static get requires() {
            return [ Widget ] as const;
        }

        init() {
            const editor = this.editor;
            editor.model.schema.register(MODEL_NAME, {
                inheritAllFrom: "$inlineObject",
                allowAttributes: [ "personId", "personName" ]
            });

            editor.conversion.for("upcast").elementToElement({
                view: { name: "span", classes: MENTION_CLASS, attributes: { [MENTION_PERSON_ATTRIBUTE]: true } },
                model: (viewElement, { writer }) => {
                    const personId = String(viewElement.getAttribute(MENTION_PERSON_ATTRIBUTE) ?? "");
                    const text = [ ...viewElement.getChildren() ].map((child) => child.is("$text") ? child.data : "").join("");
                    const personName = String(viewElement.getAttribute(MENTION_NAME_ATTRIBUTE) ?? text.replace(/^@/, ""));
                    return writer.createElement(MODEL_NAME, { personId, personName });
                },
                converterPriority: "highest"
            });

            editor.conversion.for("dataDowncast").elementToElement({
                model: MODEL_NAME,
                view: (modelElement, { writer }) => {
                    const attributes = mentionAttributes(modelElement);
                    const span = writer.createContainerElement("span", attributes);
                    writer.insert(writer.createPositionAt(span, 0), writer.createText(`@${attributes[MENTION_NAME_ATTRIBUTE]}`));
                    return span;
                }
            });

            editor.conversion.for("editingDowncast").elementToElement({
                model: MODEL_NAME,
                view: (modelElement, { writer }) => {
                    const id = String(modelElement.getAttribute("personId") ?? "");
                    const color = host.person(id)?.color;
                    const span = writer.createContainerElement("span", {
                        ...mentionAttributes(modelElement),
                        ...(color ? { style: `--tf-person-color: ${color}` } : {})
                    });
                    writer.insert(writer.createPositionAt(span, 0), writer.createText(`@${labelOf(id)}`));
                    return toWidget(span, writer);
                }
            });

            editor.editing.mapper.on("viewToModelPosition", viewToModelPositionOutsideModelElement(
                editor.model, (viewElement) => viewElement.hasClass(MENTION_CLASS)
            ));

            editor.ui.componentFactory.add("tfComment", (locale) => {
                const button = new ButtonView(locale);
                button.set({ label: t("tf.team.comment"), icon: COMMENT_ICON, tooltip: true, withText: true });
                button.on("execute", () => host.startComment(editor));
                button.bind("isEnabled").to(editor, "isReadOnly", () => host.canComment());
                return button;
            });
        }

        afterInit() {
            const editor = this.editor;
            editor.data.on("set", () => host.contentLoaded(editor), { priority: "low" });
            editor.model.document.on("change:data", (_event, batch) => host.modelChanged(editor, batch));
            this.unsubscribePeople = host.subscribePeople(() => redrawMentions(editor));
            if (editor.plugins.has(ClipboardPipeline)) {
                this.listenTo<ClipboardInputTransformationEvent>(editor.plugins.get(ClipboardPipeline), "inputTransformation", (_event, data) => {
                    stripForeignMentions(data.content);
                }, { priority: "high" });
            }

            const command = editor.commands.get("mention");
            command?.on("execute", (event, args) => {
                const options = (args as [ { mention?: { notePath?: unknown }; range?: ModelRange } ])[0];
                const path = options?.mention?.notePath;
                if (typeof path !== "string" || !path.startsWith(TF_PERSON_PATH_PREFIX)) {
                    return;
                }
                event.stop();
                insertMention(editor, path.slice(TF_PERSON_PATH_PREFIX.length), options.range);
            }, { priority: "high" });
        }

        private unsubscribePeople: (() => void) | null = null;

        override destroy() {
            this.unsubscribePeople?.();
            this.unsubscribePeople = null;
            super.destroy();
        }
    };

    /** The name a mention shows: looked up from its id, never the name the HTML carries. */
    function labelOf(personId: string) {
        return mentionLabel(host.person(personId)?.name, host.isMember(personId), t("tf.team.unknown_person"));
    }

    /** The attributes a mention is saved with; the name is the current one when it is known. */
    function mentionAttributes(modelElement: ModelElement) {
        const personId = String(modelElement.getAttribute("personId") ?? "");
        const known = host.isMember(personId) ? host.person(personId)?.name : undefined;
        return {
            class: MENTION_CLASS,
            [MENTION_PERSON_ATTRIBUTE]: personId,
            [MENTION_NAME_ATTRIBUTE]: known ?? String(modelElement.getAttribute("personName") ?? "")
        };
    }

    /** Turns pasted mentions of people outside this notebook into plain text. */
    function stripForeignMentions(content: ViewDocumentFragment) {
        const foreign: ViewElement[] = [];
        const visit = (parent: ViewDocumentFragment | ViewElement) => {
            for (const child of parent.getChildren()) {
                if (!child.is("element")) {
                    continue;
                }
                const personId = child.getAttribute(MENTION_PERSON_ATTRIBUTE);
                if (child.hasClass(MENTION_CLASS) && personId !== undefined) {
                    if (host.isMember(String(personId)) === false) {
                        foreign.push(child);
                    }
                    continue;
                }
                visit(child);
            }
        };
        visit(content);
        if (!foreign.length) {
            return;
        }
        const writer = new ViewUpcastWriter(content.document);
        for (const element of foreign) {
            const parent = element.parent;
            if (!parent) {
                continue;
            }
            const text = [ ...element.getChildren() ].map((child) => child.is("$text") ? child.data : "").join("");
            const index = parent.getChildIndex(element);
            writer.remove(element);
            writer.insertChild(index, writer.createText(text), parent as ViewElement);
        }
    }

    function insertMention(editor: Editor, personId: string, range: ModelRange | undefined) {
        const person = host.person(personId);
        const model = editor.model;
        let inserted: ModelElement | null = null;
        model.change((writer) => {
            const element = writer.createElement(MODEL_NAME, { personId, personName: person?.name ?? "" });
            model.insertContent(element, range ?? model.document.selection);
            writer.setSelection(element, "after");
            model.insertContent(writer.createText(" "));
            inserted = element;
        });
        const block = findBlock(editor, inserted);
        if (block) {
            assignBlockId(model, block);
        }
    }
}

/** Draws every mention again, after the people list changed. */
function redrawMentions(editor: Editor) {
    for (const root of editor.model.document.getRoots()) {
        for (const { item } of editor.model.createRangeIn(root)) {
            if (item.is("element", MODEL_NAME)) {
                editor.editing.reconvertItem(item);
            }
        }
    }
}
