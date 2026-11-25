/**
 * The "Voice note" entry of the text editor: a toolbar item (in the insert group on the desktop,
 * on the phone's toolbar island and in its insert sheet) and a slash command. Added to the editor
 * configuration by `tfExtendEditorConfig()` only inside a frame, so upstream Trilium is unchanged.
 */
import { ButtonView, type CKTextEditor, type SlashCommandDefinition } from "@triliumnext/ckeditor5";

import { t } from "../../../services/i18n.js";
import { getTfBootstrap, subscribeTf } from "../../state.js";

export const TF_VOICE_ITEM = "tfVoiceNote";

/** A microphone in CKEditor's 20 x 20 icon grid. */
export const MICROPHONE_ICON = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 20 20\"><path fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M10 2.75a2.5 2.5 0 0 0-2.5 2.5v4.5a2.5 2.5 0 0 0 5 0v-4.5a2.5 2.5 0 0 0-2.5-2.5ZM4.75 9.5a5.25 5.25 0 0 0 10.5 0M10 14.75v2.5M7.25 17.25h5.5\"/></svg>";

const mayRecord = () => getTfBootstrap()?.user?.role !== "view";

async function start(editor: CKTextEditor) {
    const { startVoiceNote } = await import("./session.js");
    await startVoiceNote(editor);
}

/** Registers the toolbar item. A function plugin, so no editor class needs to know about it. */
export function TfVoiceNotePlugin(editor: CKTextEditor) {
    editor.ui.componentFactory.add(TF_VOICE_ITEM, (locale) => {
        const button = new ButtonView(locale);
        button.set({
            label: t("tf.reach.voice_note"),
            icon: MICROPHONE_ICON,
            tooltip: true,
            class: "tf-voice-note-button"
        });
        const refresh = () => {
            button.isEnabled = !editor.isReadOnly && mayRecord();
            button.isVisible = mayRecord();
        };
        refresh();
        editor.on("change:isReadOnly", refresh);
        const unsubscribe = subscribeTf(refresh);
        editor.on("destroy", unsubscribe);
        button.on("execute", () => void start(editor));
        return button;
    });
}

/** The slash command, for `slashCommand.tfExtraCommands`. */
export function voiceSlashCommands(): SlashCommandDefinition[] {
    return [ {
        id: TF_VOICE_ITEM,
        title: t("tf.reach.voice_note"),
        description: t("tf.reach.voice_note_description"),
        aliases: [ "voice", "audio", "record", "microphone", "dictate", "spraak", "opname" ],
        iconClass: "bx bx-microphone",
        willInsert: true,
        isEnabled: (editor) => !editor.isReadOnly && mayRecord(),
        execute: (editor) => void start(editor as CKTextEditor)
    } ];
}

interface ToolbarGroup {
    items: unknown[];
    asMenu?: unknown;
}

/**
 * Adds the voice note to a built editor configuration: the plugin, the item in every insert group
 * (after "Insert media"), on the phone's toolbar row after the paperclip, and the slash command.
 * Nothing changes outside a frame or for a person with the `view` role.
 */
export function addVoiceNoteToConfig<T extends object>(config: T, { inFrame, isMobile }: { inFrame: boolean; isMobile: boolean }): T {
    if (!inFrame || !mayRecord()) {
        return config;
    }
    const result = config as T & {
        extraPlugins?: unknown[];
        toolbar?: { items?: unknown[] } | unknown[];
        blockToolbar?: unknown[];
        slashCommand?: { tfExtraCommands?: (editor: unknown) => SlashCommandDefinition[] };
    };
    result.extraPlugins = [ ...(result.extraPlugins ?? []), TfVoiceNotePlugin ];

    const toolbarItems = Array.isArray(result.toolbar) ? result.toolbar : result.toolbar?.items;
    for (const items of [ toolbarItems, result.blockToolbar ]) {
        if (!items) continue;
        for (const item of items) {
            if (isInsertGroup(item)) {
                insertAfter(item.items, "insertMedia", TF_VOICE_ITEM);
            }
        }
    }
    if (isMobile && toolbarItems) {
        insertAfter(toolbarItems, "attachMenu", TF_VOICE_ITEM);
    }

    const previous = result.slashCommand?.tfExtraCommands;
    result.slashCommand = {
        ...result.slashCommand,
        tfExtraCommands: (editor) => [ ...(previous?.(editor) ?? []), ...voiceSlashCommands() ]
    };
    return config;
}

function isInsertGroup(item: unknown): item is ToolbarGroup {
    return !!item && typeof item === "object" && Array.isArray((item as ToolbarGroup).items) && !!(item as ToolbarGroup).asMenu;
}

/** Puts `name` after `anchor` in `items`, or at the end without one; never twice. */
export function insertAfter(items: unknown[], anchor: string, name: string) {
    if (items.includes(name)) {
        return;
    }
    const index = items.indexOf(anchor);
    if (index === -1) {
        items.push(name);
    } else {
        items.splice(index + 1, 0, name);
    }
}
