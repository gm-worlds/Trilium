/**
 * Read-only access for people with the `view` role in an embedded notebook.
 *
 * Every write to the document records an entity change, and every entity save or soft delete goes
 * through `AbstractBeccaEntity`, so the checks sit there and in `putEntityChange()`: one call per
 * write path instead of one per route. The checks throw {@link TfReadOnlyError}, which the API layer
 * answers with `403 { tfReadOnly: true }`.
 */
import { ForbiddenError } from "../errors.js";
import { getTfUser } from "./identity.js";
import { isOwnTfUserOption } from "./options.js";

export class TfReadOnlyError extends ForbiddenError {
    readonly tfReadOnly = true;

    constructor(entityName: string) {
        super(`This notebook is read-only for you (refused a write to ${entityName}).`);
        this.name = "TfReadOnlyError";
    }
}

/**
 * Entities a viewer still writes: recent notes are local navigation history without an entity
 * change, and a viewer's own `tfu.<id>.*` options are their personal settings.
 */
export function assertTfWritable(entityName: string, entityId: string | undefined | null) {
    const user = getTfUser();
    if (user?.role !== "view") {
        return;
    }

    if (entityName === "recent_notes") {
        return;
    }

    if (entityName === "options" && entityId && isOwnTfUserOption(entityId, user.id)) {
        return;
    }

    throw new TfReadOnlyError(entityName);
}

export function isTfReadOnlyError(e: unknown): e is TfReadOnlyError {
    return e instanceof TfReadOnlyError;
}
