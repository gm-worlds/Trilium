/**
 * The touch layer of the Taskforce embedding (capability `tf-touch-1`): 44 px targets, touch
 * reordering in the phone navigator and the note tree, a block handle and pinch-to-resize text in
 * text notes, keeping the caret above the keyboard, press feedback with a name preview on dense
 * toolbars, and `haptic` messages for the host. Started by
 * `startTf()` once the page is known to be embedded; the CSS applies only under
 * `:root.tf-embedded.tf-touch`.
 */
import "./touch.css";

import appContext from "../../components/app_context.js";
import Component from "../../components/component.js";
import type LoadResults from "../../services/load_results.js";
import options from "../../services/options.js";
import { registerCapability } from "../bridge.js";
import { TF_VIEWPORT_EVENT } from "../theme.js";
import { installBlockHandle } from "./block_handle.js";
import { installImageGestures } from "./image_gestures.js";
import { installIncludedTodos } from "./included_todos.js";
import { parseTextScale } from "./gestures.js";
import { installKeyboardFollow } from "./keyboard.js";
import { installMapGestures } from "./map_gestures.js";
import { installNavigatorDrag } from "./navigator_drag.js";
import { installPressFeedback } from "./press.js";
import { installTextSize, setTextScale, TEXT_SCALE_OPTION } from "./text_size.js";
import { installTreeDrag } from "./tree_drag.js";

export const TF_TOUCH_CAPABILITY = "tf-touch-1";

let installed = false;

export function installTfMobile() {
    if (installed) {
        return;
    }
    installed = true;
    registerCapability(TF_TOUCH_CAPABILITY);

    const root = document.documentElement;
    const coarse = window.matchMedia("(pointer: coarse)");
    const update = () => root.classList.toggle("tf-touch", coarse.matches || root.classList.contains("tf-coarse-pointer"));
    update();
    coarse.addEventListener("change", update);
    window.addEventListener(TF_VIEWPORT_EVENT, update);
    const isTouch = () => root.classList.contains("tf-touch");

    installNavigatorDrag(isTouch);
    installTreeDrag(isTouch);
    installBlockHandle(isTouch);
    installTextSize(isTouch);
    installKeyboardFollow(isTouch);
    installMapGestures(isTouch);
    installImageGestures(isTouch);
    installIncludedTodos(isTouch);
    installPressFeedback(isTouch);
    appContext.child(new TfTouchOptionsWatcher());
}

/** Applies a text size the person changed on another device or tab. */
class TfTouchOptionsWatcher extends Component {
    entitiesReloadedEvent({ loadResults }: { loadResults: LoadResults }) {
        if ((loadResults.getOptionNames() as string[]).includes(TEXT_SCALE_OPTION)) {
            setTextScale(parseTextScale(options.get(TEXT_SCALE_OPTION as never)), { save: false });
        }
    }
}
