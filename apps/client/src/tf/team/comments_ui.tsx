/**
 * The "Comments" tab of the right pane and of the phone note panel: the threads of the open note,
 * a composer with `@` to name people, replies, resolve and reopen, and edit and delete for one's
 * own comments. Threads attached to a block quote it; pressing the quote shows the block.
 */
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

import { flashBlocks } from "@triliumnext/ckeditor5/src/plugins/block_reference/block_reference_read_only.js";

import dialog from "../../services/dialog.js";
import { t } from "../../services/i18n.js";
import toast from "../../services/toast.js";
import { NavigatedInNote } from "../../widgets/sidebar/RightPanelWidget.js";
import RightPanelWidget from "../../widgets/sidebar/RightPanelWidget.js";
import Button from "../../widgets/react/Button.js";
import { ExternallyControlledCollapsible } from "../../widgets/react/Collapsible.js";
import FormTextArea from "../../widgets/react/FormTextArea.js";
import { useActiveNoteContext } from "../../widgets/react/hooks.js";
import NoItems from "../../widgets/react/NoItems.js";
import { tfFetch, TfGatewayError } from "../gateway.js";
import { AuthorLine } from "./authors_ui.js";
import { activeSplit, blockElement, textContentIn } from "./editors.js";
import { type Comment, formatAgo, mentionedIn, mentionQueryAt, type Person, type Thread } from "./model.js";
import { Avatar } from "./presence_ui.js";
import {
    applyOwnComment, canWrite, getTeam, loadPeople, loadThreads, searchPeople, setTeam, useTeam
} from "./store.js";

const drafts = new Map<string, string>();

export function CommentsWidget() {
    const { note } = useActiveNoteContext();
    const noteId = note?.noteId;

    return (
        <RightPanelWidget id="tf-comments" title={t("tf.team.comments")} grow noPadding>
            {noteId ? <CommentsPanel key={noteId} noteId={noteId} /> : <NoItems icon="bx bx-message-square-dots" text={t("tf.team.no_note")} />}
        </RightPanelWidget>
    );
}

function CommentsPanel({ noteId }: { noteId: string }) {
    const team = useTeam();
    const threads = team.threads.get(noteId);
    const [ resolvedOpen, setResolvedOpen ] = useState(false);
    const [ flashId, setFlashId ] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    useTick(30_000);

    useEffect(() => {
        void loadThreads(noteId, true);
        void loadPeople();
    }, [ noteId ]);

    const open = (threads ?? []).filter((thread) => !thread.resolvedAt);
    const resolved = (threads ?? []).filter((thread) => !!thread.resolvedAt);
    const focus = team.focusThread;

    useLayoutEffect(() => {
        if (!focus || focus.noteId !== noteId || !threads) {
            return;
        }
        if (resolved.some((thread) => thread.id === focus.threadId)) {
            setResolvedOpen(true);
        }
        const timer = window.setTimeout(() => {
            const element = listRef.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(focus.threadId)}"]`);
            element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            setFlashId(focus.threadId);
            window.setTimeout(() => setFlashId(null), 1400);
        }, 80);
        return () => window.clearTimeout(timer);
    }, [ focus?.at, threads ]);

    const target = team.commentTarget?.noteId === noteId ? team.commentTarget : null;

    return (
        <div className="tf-team-comments">
            <div className="tf-team-comments-scroll" ref={listRef}>
                <AuthorLine noteId={noteId} className="tf-team-comments-author" />
                {!threads && <div className="tf-team-comments-loading">{t("tf.team.loading")}</div>}
                {threads && open.length === 0 && resolved.length === 0 && (
                    <NoItems icon="bx bx-message-square-dots" text={canWrite() ? t("tf.team.no_comments") : t("tf.team.no_comments_read")} />
                )}
                {open.map((thread) => <ThreadView key={thread.id} thread={thread} flashing={flashId === thread.id} />)}
                {resolved.length > 0 && (
                    <ExternallyControlledCollapsible
                        className="tf-team-resolved"
                        title={t("tf.team.resolved_count", { count: resolved.length })}
                        expanded={resolvedOpen}
                        setExpanded={setResolvedOpen}
                    >
                        {resolved.map((thread) => <ThreadView key={thread.id} thread={thread} flashing={flashId === thread.id} />)}
                    </ExternallyControlledCollapsible>
                )}
            </div>
            {canWrite()
                ? (
                    <div className="tf-team-composer-dock">
                        {target && (
                            <div className="tf-team-composer-target">
                                <span className="bx bx-comment-detail" aria-hidden="true" />
                                <span className="tf-team-composer-target-text">{target.quote ? `“${target.quote}”` : t("tf.team.on_block")}</span>
                                <Button kind="lowProfile" size="small" text={t("tf.team.cancel")} onClick={() => setTeam({ commentTarget: null })} />
                            </div>
                        )}
                        <Composer
                            draftKey={`note:${noteId}`}
                            autoFocusAt={target?.at}
                            placeholder={t("tf.team.composer_placeholder")}
                            submitLabel={t("tf.team.comment")}
                            onSubmit={async (body, mentions) => {
                                const answer = await tfFetch<{ comment: Comment }>("comments", {
                                    json: {
                                        noteId,
                                        body,
                                        mentions: mentions.map((person) => person.id),
                                        ...(target?.blockId ? { blockId: target.blockId } : {}),
                                        ...(target?.quote ? { quote: target.quote } : {})
                                    }
                                });
                                applyOwnComment("comment.created", answer.comment);
                                if (target) {
                                    setTeam({ commentTarget: null });
                                }
                            }}
                        />
                    </div>
                )
                : <div className="tf-team-read-only">{t("tf.team.read_only")}</div>}
        </div>
    );
}

function ThreadView({ thread, flashing }: { thread: Thread; flashing: boolean }) {
    const [ replying, setReplying ] = useState(false);
    const isResolved = !!thread.resolvedAt;
    const closePanel = useContext(NavigatedInNote);

    return (
        <article
            className={`tf-team-thread${isResolved ? " is-resolved" : ""}${flashing ? " is-flashing" : ""}`}
            data-thread-id={thread.id}
            aria-label={t("tf.team.thread_by", { name: thread.author?.name ?? t("tf.team.someone") })}
        >
            {thread.quote && thread.blockId && (
                <button type="button" className="tf-team-quote" title={t("tf.team.show_block")} onClick={() => showBlock(thread.blockId as string, closePanel)}>
                    <span className="tf-team-quote-text">{thread.quote}</span>
                </button>
            )}
            {thread.quote && !thread.blockId && <div className="tf-team-quote is-static"><span className="tf-team-quote-text">{thread.quote}</span></div>}
            <CommentView comment={thread} />
            {thread.replies.map((reply) => <CommentView key={reply.id} comment={reply} isReply />)}
            {isResolved && thread.resolvedBy && (
                <div className="tf-team-resolved-by">{t("tf.team.resolved_by", { name: thread.resolvedBy.name })}</div>
            )}
            {canWrite() && (
                replying
                    ? (
                        <Composer
                            draftKey={`thread:${thread.id}`}
                            autoFocusAt={1}
                            compact
                            placeholder={t("tf.team.reply_placeholder")}
                            submitLabel={t("tf.team.reply")}
                            onCancel={() => setReplying(false)}
                            onSubmit={async (body, mentions) => {
                                const answer = await tfFetch<{ comment: Comment }>("comments", {
                                    json: { noteId: thread.noteId, threadId: thread.id, body, mentions: mentions.map((person) => person.id) }
                                });
                                applyOwnComment("comment.created", answer.comment);
                                if (isResolved) {
                                    applyOwnComment("comment.resolved", { ...thread, resolvedAt: null, resolvedBy: null });
                                }
                                setReplying(false);
                            }}
                        />
                    )
                    : (
                        <div className="tf-team-thread-actions">
                            <Button kind="lowProfile" size="small" icon="bx bx-reply" text={t("tf.team.reply")} onClick={() => setReplying(true)} />
                            <Button
                                kind="lowProfile" size="small"
                                icon={isResolved ? "bx bx-revision" : "bx bx-check"}
                                text={isResolved ? t("tf.team.reopen") : t("tf.team.resolve")}
                                onClick={() => void setResolved(thread, !isResolved)}
                            />
                        </div>
                    )
            )}
        </article>
    );
}

function CommentView({ comment, isReply }: { comment: Comment; isReply?: boolean }) {
    const team = useTeam();
    const [ editing, setEditing ] = useState(false);
    const isOwn = !!comment.author && comment.author.id === team.self?.id;

    return (
        <div className={isReply ? "tf-team-comment is-reply" : "tf-team-comment"}>
            <div className="tf-team-comment-head">
                {comment.author ? <Avatar person={comment.author} size="sm" /> : <span className="tf-team-avatar tf-team-avatar-sm" aria-hidden="true" />}
                <span className="tf-team-comment-author">{comment.author?.name ?? t("tf.team.someone")}</span>
                <TimeStamp iso={comment.createdAt} />
                {comment.editedAt && <span className="tf-team-edited">{t("tf.team.edited")}</span>}
            </div>
            {comment.deleted
                ? <div className="tf-team-comment-body is-deleted">{t("tf.team.deleted")}</div>
                : editing
                    ? (
                        <Composer
                            draftKey={`edit:${comment.id}`}
                            initial={comment.body}
                            autoFocusAt={1}
                            compact
                            submitLabel={t("tf.team.save")}
                            onCancel={() => setEditing(false)}
                            onSubmit={async (body, mentions) => {
                                const answer = await tfFetch<{ comment: Comment }>(`comments/${comment.id}`, {
                                    method: "PATCH", json: { body, mentions: mentions.map((person) => person.id) }
                                });
                                applyOwnComment("comment.updated", answer.comment);
                                setEditing(false);
                            }}
                        />
                    )
                    : <div className="tf-team-comment-body">{renderBody(comment.body, comment.mentions)}</div>}
            {isOwn && canWrite() && !comment.deleted && !editing && (
                <div className="tf-team-comment-own">
                    <Button kind="lowProfile" size="small" text={t("tf.team.edit")} onClick={() => setEditing(true)} />
                    <Button kind="lowProfile" size="small" text={t("tf.team.delete")} onClick={() => void deleteComment(comment)} />
                </div>
            )}
        </div>
    );
}

/** "3 min ago"; pressing it shows the date and time instead, and back. */
function TimeStamp({ iso }: { iso: string }) {
    const [ absolute, setAbsolute ] = useState(false);
    const locale = document.documentElement.lang || "en";
    const full = new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
    return (
        <button type="button" className="tf-team-time" title={full} aria-label={full} onClick={() => setAbsolute(!absolute)}>
            {absolute ? full : formatAgo(iso, Date.now(), locale, t("tf.team.just_now"))}
        </button>
    );
}

/** The body as text, with each `@Name` of a mentioned person underlined in their colour. */
function renderBody(body: string, mentions: Person[]): ComponentChildren {
    const tokens = mentions.map((person) => ({ person, token: `@${person.name}` })).toSorted((a, b) => b.token.length - a.token.length);
    if (!tokens.length) {
        return body;
    }
    const parts: ComponentChildren[] = [];
    let rest = body;
    let key = 0;
    while (rest) {
        let best: { index: number; token: string; person: Person } | null = null;
        for (const { person, token } of tokens) {
            const index = rest.indexOf(token);
            if (index >= 0 && (!best || index < best.index)) {
                best = { index, token, person };
            }
        }
        if (!best) {
            parts.push(rest);
            break;
        }
        parts.push(rest.slice(0, best.index));
        parts.push(<span key={key++} className="tf-team-mention-text" style={{ "--tf-person-color": best.person.color }}>{best.token}</span>);
        rest = rest.slice(best.index + best.token.length);
    }
    return parts;
}

async function setResolved(thread: Thread, resolved: boolean) {
    try {
        const answer = await tfFetch<{ comment: Comment }>(`comments/${thread.id}/${resolved ? "resolve" : "reopen"}`, { json: {} });
        applyOwnComment("comment.resolved", answer.comment);
    } catch (e) {
        showFailure(e);
    }
}

async function deleteComment(comment: Comment) {
    if (!await dialog.confirm(t("tf.team.delete_confirm"))) {
        return;
    }
    try {
        const answer = await tfFetch<{ comment: Comment }>(`comments/${comment.id}`, { method: "DELETE" });
        applyOwnComment("comment.deleted", answer.comment);
    } catch (e) {
        showFailure(e);
    }
}

function showFailure(e: unknown) {
    const status = e instanceof TfGatewayError ? e.status : 0;
    toast.showError(status === 403 ? t("tf.team.not_allowed") : t("tf.team.failed"));
}

/** Scrolls the note to `blockId` and flashes it; on a phone the panel closes first. */
export function showBlock(blockId: string, closePanel?: (() => void) | null) {
    closePanel?.();
    window.setTimeout(() => {
        const element = blockElement(textContentIn(activeSplit()), blockId);
        if (!element) {
            toast.showMessage(t("tf.team.block_gone"));
            return;
        }
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        flashBlocks([ element ]);
    }, closePanel ? 250 : 0);
}

function useTick(ms: number) {
    const [ , setTick ] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => setTick((value) => value + 1), ms);
        return () => window.clearInterval(timer);
    }, [ ms ]);
}

//#region Composer

interface ComposerProps {
    draftKey: string;
    initial?: string;
    placeholder?: string;
    submitLabel: string;
    compact?: boolean;
    /** Focuses the field whenever this changes to a truthy value. */
    autoFocusAt?: number;
    onSubmit(body: string, mentions: Person[]): Promise<void>;
    onCancel?(): void;
}

const PEOPLE_SEARCH_DELAY_MS = 200;

/** A field that grows with its text, sends on Cmd/Ctrl+Enter and offers people after `@`. */
export function Composer({ draftKey, initial, placeholder, submitLabel, compact, autoFocusAt, onSubmit, onCancel }: ComposerProps) {
    const [ value, setValueState ] = useState(() => drafts.get(draftKey) ?? initial ?? "");
    const [ busy, setBusy ] = useState(false);
    const [ query, setQuery ] = useState<{ start: number; query: string } | null>(null);
    const [ matches, setMatches ] = useState<Person[]>([]);
    const [ active, setActive ] = useState(0);
    const picked = useRef<Person[]>([]);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const listId = useMemo(() => `tf-team-people-${Math.random().toString(36).slice(2, 8)}`, []);

    const setValue = (next: string) => {
        setValueState(next);
        drafts.set(draftKey, next);
    };

    useEffect(() => {
        if (autoFocusAt) {
            inputRef.current?.focus();
        }
    }, [ autoFocusAt ]);

    useLayoutEffect(() => {
        const input = inputRef.current;
        if (input) {
            input.style.height = "auto";
            input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
        }
    }, [ value ]);

    useEffect(() => {
        if (!query) {
            setMatches([]);
            return;
        }
        // A pause in typing first; an answer to an older query is dropped.
        let cancelled = false;
        const timer = window.setTimeout(() => {
            void searchPeople(query.query, 6).then((people) => {
                if (!cancelled) {
                    setMatches(people);
                    setActive(0);
                }
            });
        }, query.query ? PEOPLE_SEARCH_DELAY_MS : 0);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [ query?.query, query?.start ]);

    const updateQuery = () => {
        const input = inputRef.current;
        if (input) {
            setQuery(mentionQueryAt(input.value, input.selectionStart ?? input.value.length));
        }
    };

    const pick = (person: Person) => {
        const input = inputRef.current;
        if (!input || !query) {
            return;
        }
        const caret = input.selectionStart ?? value.length;
        const next = `${value.slice(0, query.start)}@${person.name} ${value.slice(caret)}`;
        if (!picked.current.some((other) => other.id === person.id)) {
            picked.current = [ ...picked.current, person ];
        }
        setValue(next);
        setQuery(null);
        const at = query.start + person.name.length + 2;
        window.requestAnimationFrame(() => {
            input.focus();
            input.setSelectionRange(at, at);
        });
    };

    const submit = async () => {
        const body = value.trim();
        if (!body || busy) {
            return;
        }
        setBusy(true);
        try {
            const candidates = [ ...picked.current, ...getTeam().people.filter((person) => person.id !== getTeam().self?.id) ];
            await onSubmit(body, mentionedIn(body, candidates));
            drafts.delete(draftKey);
            setValueState("");
            picked.current = [];
        } catch (e) {
            showFailure(e);
        } finally {
            setBusy(false);
        }
    };

    const listShown = !!query && matches.length > 0;

    return (
        <div className={compact ? "tf-team-composer is-compact" : "tf-team-composer"}>
            {listShown && (
                <ul className="tf-team-people-list" id={listId} role="listbox" aria-label={t("tf.team.people")}>
                    {matches.map((person, index) => (
                        <li
                            key={person.id}
                            id={`${listId}-${index}`}
                            role="option"
                            aria-selected={index === active}
                            className={index === active ? "tf-team-people-option is-active" : "tf-team-people-option"}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pick(person)}
                        >
                            <Avatar person={person} size="sm" />
                            <span>{person.name}</span>
                        </li>
                    ))}
                </ul>
            )}
            <FormTextArea
                inputRef={inputRef}
                className="tf-team-composer-input"
                currentValue={value}
                rows={1}
                placeholder={placeholder}
                aria-label={placeholder ?? submitLabel}
                aria-controls={listShown ? listId : undefined}
                aria-activedescendant={listShown ? `${listId}-${active}` : undefined}
                onChange={(next) => {
                    setValue(next);
                    window.requestAnimationFrame(updateQuery);
                }}
                onKeyUp={(e) => {
                    if ([ "ArrowLeft", "ArrowRight", "Home", "End" ].includes(e.key)) {
                        updateQuery();
                    }
                }}
                onClick={updateQuery}
                onKeyDown={(e) => {
                    if (listShown) {
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                            e.preventDefault();
                            setActive((current) => (current + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                            return;
                        }
                        if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
                            e.preventDefault();
                            pick(matches[active]);
                            return;
                        }
                        if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            setQuery(null);
                            return;
                        }
                    }
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void submit();
                    } else if (e.key === "Escape" && onCancel) {
                        e.preventDefault();
                        onCancel();
                    }
                }}
            />
            <div className="tf-team-composer-actions">
                {onCancel && <Button kind="lowProfile" size="small" text={t("tf.team.cancel")} onClick={onCancel} />}
                <Button
                    kind="primary" size="small" className="tf-team-send"
                    text={submitLabel}
                    title={t("tf.team.send_hint")}
                    disabled={busy || !value.trim()}
                    onClick={() => void submit()}
                />
            </div>
        </div>
    );
}

//#endregion
