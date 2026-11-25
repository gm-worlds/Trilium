/**
 * A card that is chosen like a button: reachable with Tab, chosen with Enter or Space, and read out
 * as a button. Without an action it stays in the tab order, marked as unavailable.
 */
export function choiceProps(onChoose: (() => void) | undefined) {
    return {
        role: "button",
        tabIndex: 0,
        "aria-disabled": onChoose ? undefined : true,
        onClick: onChoose,
        onKeyDown: (e: KeyboardEvent) => {
            if (onChoose && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onChoose();
            }
        }
    } as const;
}
