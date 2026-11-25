import { describe, expect, it } from "vitest";

import { addVoiceNoteToConfig, insertAfter, TF_VOICE_ITEM, TfVoiceNotePlugin } from "./editor_plugin.js";

const desktopConfig = () => ({
    toolbar: { items: [ "bold", "attachMenu", { label: "Insert", asMenu: true, items: [ "math", "insertMedia", "horizontalLine" ] } ] },
    blockToolbar: [ "heading", { label: "Insert", asMenu: true, items: [ "mermaid", "insertMedia" ] }, { label: "Align", items: [ "a" ] } ]
});

describe("voice note in the editor configuration", () => {
    it("joins every insert group after Insert media, and the phone row after the paperclip", () => {
        const config = addVoiceNoteToConfig(desktopConfig(), { inFrame: true, isMobile: false }) as ReturnType<typeof desktopConfig> & {
            extraPlugins: unknown[]; slashCommand: { tfExtraCommands: (e: unknown) => { id: string }[] };
        };
        expect((config.toolbar.items[2] as { items: string[] }).items).toEqual([ "math", "insertMedia", TF_VOICE_ITEM, "horizontalLine" ]);
        expect((config.blockToolbar[1] as { items: string[] }).items).toEqual([ "mermaid", "insertMedia", TF_VOICE_ITEM ]);
        expect((config.blockToolbar[2] as { items: string[] }).items).toEqual([ "a" ]);
        expect(config.toolbar.items).not.toContain(TF_VOICE_ITEM);
        expect(config.extraPlugins).toEqual([ TfVoiceNotePlugin ]);
        expect(config.slashCommand.tfExtraCommands(null).map((c) => c.id)).toEqual([ TF_VOICE_ITEM ]);

        const phone = addVoiceNoteToConfig(desktopConfig(), { inFrame: true, isMobile: true });
        expect(phone.toolbar.items.slice(0, 3)).toEqual([ "bold", "attachMenu", TF_VOICE_ITEM ]);
    });

    it("changes nothing outside a frame", () => {
        const config = desktopConfig();
        expect(addVoiceNoteToConfig(config, { inFrame: false, isMobile: true })).toEqual(desktopConfig());
        const items = [ "a", TF_VOICE_ITEM ];
        insertAfter(items, "a", TF_VOICE_ITEM);
        expect(items).toEqual([ "a", TF_VOICE_ITEM ]);
    });
});
