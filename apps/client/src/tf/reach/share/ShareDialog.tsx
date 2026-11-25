/**
 * "Share link…": the note's live links, a new link with an end date and an optional password,
 * and the link itself, shown once. A bottom sheet on phones (the app's modal on `body.mobile`).
 */
import "./ShareDialog.css";

import { h, render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type FNote from "../../../entities/fnote.js";
import { t } from "../../../services/i18n.js";
import toast from "../../../services/toast.js";
import ActionButton from "../../../widgets/react/ActionButton.js";
import Button from "../../../widgets/react/Button.js";
import FormCheckbox from "../../../widgets/react/FormCheckbox.js";
import FormTextBox from "../../../widgets/react/FormTextBox.js";
import Modal from "../../../widgets/react/Modal.js";
import SegmentedChoice from "../../../widgets/react/SegmentedChoice.js";
import { getTfBootstrap } from "../../state.js";
import { openerOf } from "../components.js";
import { createShareLink, errorMessage, listShareLinks, patchShareLink, withdrawShareLink } from "./api.js";
import { formatDay, formatDayTime } from "./format.js";
import {
    buildCreateBody, buildEndPatch, buildPasswordPatch, DEFAULT_END_CHOICE, type EndChoice, type FormError,
    liveLinks, type ShareLinkCreated, type ShareLinkMeta, toDateInput
} from "./model.js";

let container: HTMLElement | null = null;

/**
 * Opens the dialog for `note`; one at a time. The upstream `Modal` takes the focus, keeps Tab inside
 * and closes on Escape; once it is closed the focus goes back to `opener` (the control that opened
 * it, or the menu button around a menu item).
 */
export function openShareDialog(note: FNote, opener: HTMLElement | null = openerOf(document.activeElement)) {
    closeShareDialog();
    const mine = document.createElement("div");
    mine.className = "tf-share-dialog-host";
    document.body.append(mine);
    container = mine;
    // "Closed" arrives after the hide animation; it only removes the dialog it belongs to, not
    // one opened in the meantime.
    const onClosed = () => {
        if (container !== mine) return;
        closeShareDialog();
        // After the modal's own focus handling, which aims at the menu item that is gone by now.
        setTimeout(() => {
            if (opener?.isConnected && !document.querySelector(".modal.show")) opener.focus();
        });
    };
    render(h(ShareDialog, { note, onClosed }), mine);
}


function closeShareDialog() {
    if (container) {
        render(null, container);
        container.remove();
        container = null;
    }
}

type Mode = { kind: "list" } | { kind: "create" } | { kind: "created"; link: ShareLinkCreated };

export function ShareDialog({ note, onClosed }: { note: FNote; onClosed: () => void }) {
    const [ shown, setShown ] = useState(true);
    const [ links, setLinks ] = useState<ShareLinkMeta[] | null>(null);
    const [ loadError, setLoadError ] = useState(false);
    const [ mode, setMode ] = useState<Mode>({ kind: "list" });
    const canEdit = getTfBootstrap()?.user?.role === "edit";
    const live = useMemo(() => liveLinks(links ?? []), [ links ]);

    const reload = async () => {
        try {
            const next = await listShareLinks(note.noteId);
            setLinks(next);
            setLoadError(false);
            return next;
        } catch {
            setLoadError(true);
            setLinks([]);
            return [];
        }
    };

    useEffect(() => {
        void reload().then((loaded) => {
            if (canEdit && liveLinks(loaded).length === 0) {
                setMode({ kind: "create" });
            }
        });
    }, [ note.noteId ]);

    const footer = mode.kind === "created"
        ? <Button kind="primary" text={t("tf.reach.done")} onClick={() => setShown(false)} />
        : undefined;

    return (
        <Modal
            className="tf-share-dialog"
            title={t("tf.reach.share_title")}
            size="md"
            show={shown}
            onHidden={onClosed}
            footer={footer}
            scrollable
        >
            <div className="tf-share-note-title">
                <span className="bx bx-link" aria-hidden="true" />
                <span>{note.title}</span>
            </div>
            {mode.kind === "list" && (
                <LinkList
                    note={note}
                    links={links}
                    live={live}
                    loadError={loadError}
                    canEdit={canEdit}
                    onChanged={() => void reload()}
                    onNew={() => setMode({ kind: "create" })}
                />
            )}
            {mode.kind === "create" && (
                <CreateForm
                    note={note}
                    hasLinks={live.length > 0}
                    onCancel={() => setMode({ kind: "list" })}
                    onCreated={(link) => {
                        setMode({ kind: "created", link });
                        void reload();
                    }}
                />
            )}
            {mode.kind === "created" && <CreatedLink link={mode.link} title={note.title} />}
        </Modal>
    );
}

function LinkList({ note, links, live, loadError, canEdit, onChanged, onNew }: {
    note: FNote;
    links: ShareLinkMeta[] | null;
    live: ShareLinkMeta[];
    loadError: boolean;
    canEdit: boolean;
    onChanged: () => void;
    onNew: () => void;
}) {
    return (
        <div className="tf-share-list">
            <h5 className="tf-share-heading">{t("tf.reach.live_links")}</h5>
            {links === null && (
                <div className="tf-share-empty" role="status">
                    <span className="bx bx-loader-alt bx-spin" aria-hidden="true" />
                    <span className="visually-hidden">{t("tf.reach.loading_links")}</span>
                </div>
            )}
            {loadError && <div className="tf-share-empty" role="alert">{t("tf.reach.load_failed")}</div>}
            {links !== null && !loadError && live.length === 0 && <div className="tf-share-empty">{t("tf.reach.no_links")}</div>}
            {live.length > 0 && (
                <ul className="tf-share-links">
                    {live.map((link) => <LinkRow key={link.id} note={note} link={link} canEdit={canEdit} onChanged={onChanged} />)}
                </ul>
            )}
            {canEdit
                ? <div className="tf-share-new">
                    {live.length > 0 && <p className="tf-share-hint">{t("tf.reach.copy_hint")}</p>}
                    <Button className="tf-share-make-new" icon="bx bx-plus" text={t("tf.reach.make_new")} onClick={onNew} />
                </div>
                : <p className="tf-share-hint">{t("tf.reach.view_only")}</p>}
        </div>
    );
}

type RowEdit = null | "end" | "password" | "withdraw";

function LinkRow({ note, link, canEdit, onChanged }: { note: FNote; link: ShareLinkMeta; canEdit: boolean; onChanged: () => void }) {
    const [ edit, setEdit ] = useState<RowEdit>(null);
    const [ busy, setBusy ] = useState(false);

    const run = async (work: () => Promise<unknown>, done?: string) => {
        setBusy(true);
        try {
            await work();
            setEdit(null);
            if (done) toast.showMessage(done);
            onChanged();
        } catch (e) {
            toast.showError(t("tf.reach.request_failed", { message: errorMessage(e) }));
        } finally {
            setBusy(false);
        }
    };

    const made = link.createdBy
        ? t("tf.reach.made_by", { name: link.createdBy.name, when: formatDay(link.createdAt) })
        : t("tf.reach.made_on", { when: formatDay(link.createdAt) });
    const views = link.viewCount === 0
        ? t("tf.reach.views_none")
        : `${t("tf.reach.views", { count: link.viewCount })}${link.lastViewedAt ? `, ${t("tf.reach.last_viewed", { when: formatDayTime(link.lastViewedAt) })}` : ""}`;

    return (
        <li className="tf-share-link" data-link-id={link.id}>
            <div className="tf-share-link-main">
                <div className="tf-share-link-ends">
                    <span className="bx bx-time-five" aria-hidden="true" />
                    {link.expiresAt ? t("tf.reach.ends", { when: formatDay(link.expiresAt) }) : t("tf.reach.no_end")}
                </div>
                <div className="tf-share-link-facts">
                    <span>{made}</span>
                    <span>
                        <span className={`bx ${link.hasPassword ? "bx-lock-alt" : "bx-lock-open-alt"}`} aria-hidden="true" />
                        {" "}{link.hasPassword ? t("tf.reach.has_password") : t("tf.reach.no_password")}
                    </span>
                    {link.includeChildren && <span>{t("tf.reach.with_children")}</span>}
                    <span>{views}</span>
                </div>
            </div>
            {canEdit && edit === null && (
                <div className="tf-share-link-actions">
                    <Button size="small" text={t("tf.reach.change_end")} onClick={() => setEdit("end")} />
                    {link.hasPassword
                        ? <Button size="small" text={t("tf.reach.remove_password")} disabled={busy}
                            onClick={() => void run(async () => {
                                const patch = buildPasswordPatch(null);
                                if ("body" in patch) await patchShareLink(note.noteId, link.id, patch.body);
                            })} />
                        : <Button size="small" text={t("tf.reach.set_password")} onClick={() => setEdit("password")} />}
                    <Button size="small" className="tf-share-withdraw" text={t("tf.reach.withdraw")} onClick={() => setEdit("withdraw")} />
                </div>
            )}
            {edit === "end" && (
                <EndDateForm
                    initial={link.expiresAt}
                    busy={busy}
                    onCancel={() => setEdit(null)}
                    onSave={(choice, picked) => {
                        const patch = buildEndPatch(choice, picked, new Date());
                        if ("error" in patch) return patch.error;
                        void run(() => patchShareLink(note.noteId, link.id, patch.body));
                        return null;
                    }}
                />
            )}
            {edit === "password" && (
                <PasswordForm
                    busy={busy}
                    onCancel={() => setEdit(null)}
                    onSave={(password) => {
                        const patch = buildPasswordPatch(password);
                        if ("error" in patch) return patch.error;
                        void run(() => patchShareLink(note.noteId, link.id, patch.body));
                        return null;
                    }}
                />
            )}
            {edit === "withdraw" && (
                <div className="tf-share-confirm" role="alert">
                    <span>{t("tf.reach.withdraw_confirm")}</span>
                    <div className="tf-share-row-buttons">
                        <Button size="small" text={t("tf.reach.cancel")} onClick={() => setEdit(null)} />
                        <Button size="small" kind="primary" className="tf-share-withdraw-confirm" text={t("tf.reach.withdraw")} disabled={busy}
                            onClick={() => void run(() => withdrawShareLink(note.noteId, link.id), t("tf.reach.withdrawn"))} />
                    </div>
                </div>
            )}
        </li>
    );
}

function EndChoiceField({ choice, picked, onChoice, onPicked }: {
    choice: EndChoice;
    picked: string;
    onChoice: (choice: EndChoice) => void;
    onPicked: (picked: string) => void;
}) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return (
        <div className="tf-share-field">
            <span className="tf-share-label">{t("tf.reach.end_label")}</span>
            <SegmentedChoice<EndChoice>
                className="tf-share-end-choice"
                currentValue={choice}
                onChange={onChoice}
                options={[
                    { value: "1", label: t("tf.reach.end_in_1") },
                    { value: "7", label: t("tf.reach.end_in_7") },
                    { value: "30", label: t("tf.reach.end_in_30") },
                    { value: "pick", label: t("tf.reach.end_pick") },
                    { value: "none", label: t("tf.reach.end_none") }
                ]}
            />
            {choice === "pick" && (
                <FormTextBox
                    className="tf-share-date"
                    type="date"
                    aria-label={t("tf.reach.end_date")}
                    min={toDateInput(tomorrow)}
                    currentValue={picked}
                    onChange={onPicked}
                />
            )}
        </div>
    );
}

function EndDateForm({ initial, busy, onCancel, onSave }: {
    initial: string | null;
    busy: boolean;
    onCancel: () => void;
    onSave: (choice: EndChoice, picked: string) => FormError | null;
}) {
    const [ choice, setChoice ] = useState<EndChoice>(initial ? "pick" : "none");
    const [ picked, setPicked ] = useState(initial ? toDateInput(new Date(initial)) : "");
    const [ error, setError ] = useState<FormError | null>(null);
    return (
        <div className="tf-share-inline-form">
            <EndChoiceField choice={choice} picked={picked} onChoice={setChoice} onPicked={setPicked} />
            {error && <div className="tf-share-error" role="alert">{t(`tf.reach.${error}`)}</div>}
            <div className="tf-share-row-buttons">
                <Button size="small" text={t("tf.reach.cancel")} onClick={onCancel} />
                <Button size="small" kind="primary" text={t("tf.reach.save")} disabled={busy} onClick={() => setError(onSave(choice, picked))} />
            </div>
        </div>
    );
}

function PasswordForm({ busy, onCancel, onSave }: { busy: boolean; onCancel: () => void; onSave: (password: string) => FormError | null }) {
    const [ password, setPassword ] = useState("");
    const [ error, setError ] = useState<FormError | null>(null);
    return (
        <div className="tf-share-inline-form">
            <PasswordBox label={t("tf.reach.password_new")} value={password} onChange={setPassword} />
            {error && <div className="tf-share-error" role="alert">{t(`tf.reach.${error}`)}</div>}
            <div className="tf-share-row-buttons">
                <Button size="small" text={t("tf.reach.cancel")} onClick={onCancel} />
                <Button size="small" kind="primary" text={t("tf.reach.save")} disabled={busy} onClick={() => setError(onSave(password))} />
            </div>
        </div>
    );
}

function PasswordBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    const [ visible, setVisible ] = useState(false);
    return (
        <label className="tf-share-field">
            <span className="tf-share-label">{label}</span>
            <span className="tf-share-password">
                <FormTextBox
                    className="tf-share-password-input"
                    type={visible ? "text" : "password"}
                    autocomplete="new-password"
                    currentValue={value}
                    onChange={onChange}
                />
                <ActionButton
                    className="tf-share-password-toggle"
                    icon={visible ? "bx bx-hide" : "bx bx-show"}
                    text={visible ? t("tf.reach.hide_password") : t("tf.reach.show_password")}
                    aria-pressed={visible}
                    onClick={(e) => {
                        e.preventDefault();
                        setVisible(!visible);
                    }}
                />
            </span>
            <span className="tf-share-hint">{t("tf.reach.password_hint")}</span>
        </label>
    );
}

function CreateForm({ note, hasLinks, onCancel, onCreated }: {
    note: FNote;
    hasLinks: boolean;
    onCancel: () => void;
    onCreated: (link: ShareLinkCreated) => void;
}) {
    const [ choice, setChoice ] = useState<EndChoice>(DEFAULT_END_CHOICE);
    const [ picked, setPicked ] = useState("");
    const [ password, setPassword ] = useState("");
    const [ includeChildren, setIncludeChildren ] = useState(false);
    const [ childCount, setChildCount ] = useState<number | null>(null);
    const [ error, setError ] = useState<FormError | null>(null);
    const [ busy, setBusy ] = useState(false);

    useEffect(() => {
        void note.getSubtreeNoteIds(true).then((ids) => setChildCount(ids.length)).catch(() => setChildCount(0));
    }, [ note.noteId ]);

    const submit = async () => {
        const built = buildCreateBody({ noteId: note.noteId, choice, picked, password, includeChildren }, new Date());
        if ("error" in built) {
            setError(built.error);
            return;
        }
        setError(null);
        setBusy(true);
        try {
            onCreated(await createShareLink(built.body));
        } catch (e) {
            toast.showError(t("tf.reach.request_failed", { message: errorMessage(e) }));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="tf-share-create">
            <EndChoiceField choice={choice} picked={picked} onChoice={setChoice} onPicked={setPicked} />
            <PasswordBox label={t("tf.reach.password_label")} value={password} onChange={setPassword} />
            {!!childCount && (
                <FormCheckbox
                    name="tf-share-children"
                    label={t("tf.reach.include_children", { count: childCount })}
                    currentValue={includeChildren}
                    onChange={setIncludeChildren}
                />
            )}
            {error && <div className="tf-share-error" role="alert">{t(`tf.reach.${error}`)}</div>}
            <div className="tf-share-row-buttons end">
                {hasLinks && <Button text={t("tf.reach.back")} onClick={onCancel} />}
                <Button className="tf-share-create-button" kind="primary" icon="bx bx-link" text={t("tf.reach.create")} disabled={busy} onClick={() => void submit()} />
            </div>
        </div>
    );
}

function CreatedLink({ link, title }: { link: ShareLinkCreated; title: string }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const canShare = typeof navigator.share === "function";

    useEffect(() => {
        inputRef.current?.select();
    }, []);

    const copy = async () => {
        const ok = await copyText(link.url, inputRef.current);
        if (ok) toast.showMessage(t("tf.reach.copied"));
    };

    return (
        <div className="tf-share-created">
            <p>{t("tf.reach.created")}</p>
            <div className="tf-share-url-row">
                <FormTextBox
                    inputRef={inputRef}
                    className="tf-share-url"
                    readOnly
                    aria-label={t("tf.reach.link_field")}
                    currentValue={link.url}
                    onFocus={(e: FocusEvent) => (e.currentTarget as HTMLInputElement).select()}
                />
                <Button className="tf-share-copy" icon="bx bx-copy" text={t("tf.reach.copy")} kind="primary" onClick={() => void copy()} />
                {canShare && (
                    <Button className="tf-share-native" icon="bx bx-share" text={t("tf.reach.share_native")}
                        onClick={() => void navigator.share({ title, url: link.url }).catch(() => {})} />
                )}
            </div>
            <p className="tf-share-hint">
                {link.expiresAt ? t("tf.reach.ends", { when: formatDay(link.expiresAt) }) : t("tf.reach.no_end")}
                {" · "}{link.hasPassword ? t("tf.reach.has_password") : t("tf.reach.no_password")}
            </p>
        </div>
    );
}

/** Copies `text` with the clipboard API, else by selecting it in `field` and copying the selection. */
export async function copyText(text: string, field: HTMLInputElement | null) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        if (!field) return false;
        field.focus();
        field.select();
        try {
            return document.execCommand("copy");
        } catch {
            return false;
        }
    }
}
