/**
 * Tree expansion per person in an embedded notebook.
 *
 * Upstream keeps one `isExpanded` per branch, so one person opening a folder would open it for
 * everyone. When embedded, an expand or collapse by a known person is stored in their own option
 * `tfu.<userId>.tfTreeExpanded` instead: a JSON object of branch id to `1` or `0`, holding only the
 * branches where the person differs from the shared `isExpanded`. A person without state sees the
 * shared value. The tree load and the WebSocket change events read the person's value, so the stock
 * client sends the same requests and reads `isExpanded` from branches as before.
 */
import type { EntityChange, OptionNames } from "@triliumnext/commons";

import becca from "../becca/becca.js";
import optionService from "../services/options.js";
import { getTfUserId, isTfEmbedded } from "./identity.js";
import { tfUserOptionName } from "./options.js";

export const TF_TREE_EXPANDED_OPTION = "tfTreeExpanded";

/** Most branches one person's state holds; the oldest entries go first. */
export const TF_TREE_EXPANDED_MAX = 2000;

type Overrides = Map<string, boolean>;

const parsed = new Map<string, { raw: string; overrides: Overrides }>();

interface ExpandableBranch {
    branchId?: string;
    isExpanded?: boolean;
}

/** The person's `isExpanded` for `branch`, or the shared value outside embed mode or without a person. */
export function getTfBranchExpanded(branch: ExpandableBranch): boolean {
    const userId = isTfEmbedded() ? getTfUserId() : null;
    return effectiveExpanded(branch, userId);
}

/**
 * Stores the expansion of `branchIds` for the person in context. Returns `false` when the shared
 * state applies (not embedded, or no person on the request), so the caller writes it as upstream does.
 */
export function setTfBranchesExpanded(branchIds: (string | undefined)[], expanded: boolean): boolean {
    const userId = isTfEmbedded() ? getTfUserId() : null;
    if (!userId) {
        return false;
    }

    const overrides = new Map(getTfExpansionOverrides(userId));
    for (const branchId of branchIds) {
        if (!branchId) {
            continue;
        }
        overrides.delete(branchId);
        const branch = becca.branches[branchId];
        if (branch && branch.isExpanded !== expanded) {
            overrides.set(branchId, expanded);
        }
    }

    for (const branchId of overrides.keys()) {
        if (!becca.branches[branchId]) {
            overrides.delete(branchId);
        }
    }
    while (overrides.size > TF_TREE_EXPANDED_MAX) {
        const oldest = overrides.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        overrides.delete(oldest);
    }

    const value = JSON.stringify(Object.fromEntries([ ...overrides ].map(([ id, on ]) => [ id, on ? 1 : 0 ])));
    const name = tfUserOptionName(userId, TF_TREE_EXPANDED_OPTION);
    if (becca.getOption(name)?.value !== value) {
        optionService.setOption(name as OptionNames, value);
    }
    return true;
}

/** The branches where the person with `userId` differs from the shared `isExpanded`. */
export function getTfExpansionOverrides(userId: string): Overrides {
    const raw = becca.getOption(tfUserOptionName(userId, TF_TREE_EXPANDED_OPTION))?.value ?? "";
    const cached = parsed.get(userId);
    if (cached && cached.raw === raw) {
        return cached.overrides;
    }

    const overrides: Overrides = new Map();
    try {
        const object = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        for (const [ branchId, on ] of Object.entries(object)) {
            overrides.set(branchId, on === 1 || on === true);
        }
    } catch {
        // A damaged value counts as no state; the next write replaces it.
    }
    parsed.set(userId, { raw, overrides });
    return overrides;
}

/**
 * Gives the branch rows of a `frontend-update` message the expansion of the person with `userId`,
 * so a branch change made by someone else never carries their tree state to this person.
 */
export function applyTfExpansionToEntityChanges(entityChanges: EntityChange[], userId: string | null): EntityChange[] {
    if (!userId) {
        return entityChanges;
    }

    return entityChanges.map((change) => {
        const entity = change.entity as ExpandableBranch | null | undefined;
        if (change.entityName !== "branches" || !entity || typeof entity.isExpanded !== "boolean") {
            return change;
        }

        const isExpanded = effectiveExpanded({ branchId: change.entityId, isExpanded: entity.isExpanded }, userId);
        return isExpanded === entity.isExpanded ? change : { ...change, entity: { ...entity, isExpanded } } as EntityChange;
    });
}

function effectiveExpanded(branch: ExpandableBranch, userId: string | null) {
    const shared = !!branch.isExpanded;
    if (!userId || !branch.branchId) {
        return shared;
    }
    return getTfExpansionOverrides(userId).get(branch.branchId) ?? shared;
}
