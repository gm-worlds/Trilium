/**
 * Who opened the protected session. Trilium has one protected session per engine process, so
 * once someone enters the password, protected notes are open for everyone in the notebook.
 */
import { isProtectedSessionAvailable } from "../services/protected_session.js";
import { getTfUser, type TfUser } from "./identity.js";

let unlockedBy: Pick<TfUser, "id" | "name"> | null = null;

export function recordTfProtectedSession(unlocked: boolean) {
    if (!unlocked) {
        unlockedBy = null;
        return;
    }

    const user = getTfUser();
    unlockedBy = user ? { id: user.id, name: user.name } : null;
}

export function getTfProtectedState(): { unlocked: boolean; by: { id: string; name: string } | null } {
    const unlocked = isProtectedSessionAvailable();
    return { unlocked, by: unlocked ? unlockedBy : null };
}
