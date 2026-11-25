# NoteForce patch stack (`tf/stack`)

NoteForce is this fork of Trilium Notes, embedded in Taskforce as one notebook per engine
process behind the Taskforce notes gateway. The contract between engine, gateway and Taskforce
lives in the Taskforce repository, `infra/notes/README.md`. Source of this fork:
https://github.com/gm-worlds/trilium (AGPL-3.0; the About dialog links to it when embedded).

The stack is rebased onto every upstream release, so:

- all new code lives in `packages/trilium-core/src/tf/`, `apps/server/src/tf/` and `apps/client/src/tf/`;
- upstream files get the smallest possible hook, each line marked `// tf:`;
- `packages/trilium-core` stays free of Node built-ins: the server reads the environment and posts
  events, core only gets `initTfCore()` and the request identity through the execution context;
- no database migrations and no new tables (per-person options are ordinary option rows);
- with `TF_EMBED` unset every hook is a no-op and the fork behaves like upstream.

## What `TF_EMBED=1` changes

Server (env: `TF_GATEWAY_KEY`, `TF_NOTEBOOK_ID`, `TF_PARENT_ORIGINS`, `TF_EVENTS_URL`, `TF_SCRIPTS`):

- Every HTTP request and WebSocket upgrade needs `x-tf-gateway-key` = `TF_GATEWAY_KEY`
  (constant-time compare), else 403. `GET /api/health-check` stays open from loopback.
- `x-tf-user-id`, `x-tf-user-name` (URI-encoded) and `x-tf-role` become the request identity
  (`getTfUser()` in `packages/trilium-core/src/tf/identity.ts`). A malformed user id is 400.
- Per-person options (table below) are read and written as `tfu.<userId>.<name>`, with the shared
  value as the fallback. `/api/options`, `/bootstrap` and WebSocket `frontend-update` messages are
  personal: nobody receives another person's `tfu.*` rows.
- `role = view`: entity writes throw `TfReadOnlyError`, answered as 403 `{ tfReadOnly: true }`.
  A viewer still writes their own options and recent notes. Routes that run scripts, bulk actions,
  erase-now maintenance, note import and attachment upload answer a viewer 403 `{ tfReadOnly }`
  before the handler runs (`TF_VIEWER_REFUSED_ROUTES`, `apps/server/src/tf/route_policy.ts`).
- Refused for every role with 404, matched on the canonical path (decoded, lower case, no duplicate
  or trailing slash; a `.`/`..` or empty segment, an encoded slash before the last segment or a bad
  escape is refused outright), wherever upstream mounts them (`TF_REFUSED_ROUTE_PREFIXES`):
  `/api/database`, `/api/sql`, `/api/backend-log`, `/api/backup*`, `/api/etapi-tokens*`, `/etapi`,
  `/mcp*`, `/api/sync`, `/api/setup`, `/api/password`, `/api/login` (except `/api/login/protected`
  and `/api/login/protected/touch`), `/api/totp*`, `/api/oauth*`, `/api/clipper`, `/api/sender`,
  `/api/llm*`, the four `/api/special-notes/*llm-chat*` routes, `/api/resources`,
  `/api/onenote-import`, `/api/network-addresses`, `/api/metrics`. `/share` stays reachable.
  `POST /api/password/change` is open for the edit role (`TF_EDITOR_ROUTES`; 403 `{ tfReadOnly }`
  for a viewer): it sets the protected-notes password when there is none, otherwise it needs the
  current one. `/api/password/reset` and the rest of `/api/password` stay 404.
- Options nobody writes (403, the whole batch refused before any write; `packages/trilium-core/src/tf/policy.ts`):
  names starting with `sync`, `llm`, `ai`, `mcp`, `openai`, `anthropic`, `ollama`, `voyage`,
  `transcription`, `transcript`, `backup`, `dailyBackup`, `weeklyBackup`, `monthlyBackup`, and
  `allowedHtmlTags`, `customDbBackupDir`, `mfaMethod`, `checkForUpdates`, `redirectBareDomain`,
  `showLoginInShareTheme`. `GET /api/options` reports `aiEnabled`, `mcpEnabled`,
  `transcriptionEnabled`, `sqlConsoleEnabled`, `checkForUpdates` as `false`, `llmProviders` as
  `[]`, the sync and backup addresses as empty, and `backendScriptingEnabled` as `false` with
  `TF_SCRIPTS=off`.
- No sync (`isSyncSetup()` false, no sync timer, `syncRequest()` throws), no AI provider and no
  `llmFetch()` request, no SQL console, whatever the options or `config.ini` say.
- Tree expansion is per person: `PUT /api/branches/:branchId/expanded/:expanded` and
  `expanded-subtree` from a known person (any role) go to their own `tfu.<userId>.tfTreeExpanded`
  (branch ids where they differ from the shared `isExpanded`, at most 2000), never to the shared
  column. `/api/tree`, `/api/tree/load` and the branch rows of WebSocket `frontend-update`
  messages carry that person's value; a person without state sees the shared one. The stock
  client works unchanged.
- Note content fetches (images in pasted or imported HTML through `getImage()`, link previews,
  oEmbed, thumbnails and the media proxy through `safeFetch()`) all go through
  `apps/server/src/tf/outbound.ts`: http and https on the default port only, no single-label or
  `.local`/`.internal`/`.lan`/`.home.arpa`/`.localhost` names, every resolved address public
  unicast (IPv4-mapped and other embedded IPv4 forms included), the connection pinned to the
  checked address, at most 3 redirects each checked again, 20 MB and 15 s. A refusal is an
  ordinary error, so the image link stays as it was.
- Save guard on `PUT /api/notes/:noteId/data` with `tf-base-blob` (409 on a stale save, `*` forces
  the write after keeping the current content as a revision); success answers `{ blobId }`. A stale
  base goes through only for the client that wrote last (`tf-client-id`, else
  `trilium-component-id`) when the base is one that client's last write replaced, so a phone and a
  desktop of the same person, or a to-do tick followed by an editor's stale save, still get 409.
  `PUT /api/notes/:noteId/blocks` (the stock client's embedded-block editor) has the same guard,
  applied only when `tf-base-blob` is sent: the stock client sends none there.
- Raw share content (`#shareRaw`, `?raw`) and `/share/api/notes/:noteId/view` carry
  `Content-Security-Policy: sandbox; default-src 'none'` and `nosniff`, and come as an attachment
  when the mime is HTML, SVG or XML (a shared PDF no longer previews inline).
- With scripts off, the page bootstrap names no `#appCss` note and no user-made theme (a person's
  custom theme reads as `next`), and `/api/options/user-themes` answers `[]`.
- Change events are batched (at most one POST a second, three tries, never blocking a save) to
  `TF_EVENTS_URL` with the gateway key.
- `GET /api/tf/bootstrap` and `GET /api/tf/protected`.
- `TF_SCRIPTS=off|on`, default `off`: notebook scripts off without `TRILIUM_SAFE_MODE`, so open
  tabs keep restoring. Off means no frontend startup scripts, widgets, render-note scripts, custom
  request handlers or backend scripts (`isScriptingEnabled()` is false); `script/widgets` and
  `script/startup` answer `[]`, `script/bundle/*` answers `null`, and the page bootstrap carries
  `tfScriptsOff`, so the client asks for none of them and shows no script error toast.
- Options only the embedding has (`TF_OWN_OPTIONS`, per person): `tfTextScale`.

Client (active only when the page bootstrap carries `tfEmbed: true`, the page has a parent window
and `/api/tf/bootstrap` answers; `isTfEmbedCandidate()` in `tf/state.ts`. Without `TF_EMBED` the
history patch, the editor's wait for the bootstrap and the bootstrap request never happen):

- `tf/bridge.ts`: the frame ↔ host protocol 1, `registerCapability()`.
- `tf/gateway.ts`: `tfFetch()` for `/__tf/api/*`, `tfRealtime()` for `/__tf/rt`, session renewal
  after a 401 (`session.expired` → `session.refresh` → `POST /__tf/refresh`, one retry).
- `tf/save_guard.tsx`: sends `tf-base-blob` and `tf-client-id` (a random id made once per page load,
  kept in memory; also on `POST /api/tf/todos/toggle` and the transcript's save), shows the conflict dialog (Keep both, Use theirs,
  Use mine), one toast for read-only refusals. Keep both and Use theirs reload the note on the
  next task, after `SpacedUpdate` has settled the refused save (an editor ignores a reload while
  its own save is pending).
- `tf/theme.ts` + `tf/tf.css`: host light/dark (through the per-person `theme` option), accent,
  corner radius and UI font mapped onto the Next theme's variables; host viewport onto
  `--safe-area-inset-*` and the keyboard state `root_container.ts` uses.
- `tf/components.tsx`: the Taskforce button (top of the vertical launch bar, first item of the
  horizontal and mobile bars), the protected-notes notice in the title row, the About line.
- `tf/capture.ts`: links to a parent origin become `open`, host shortcuts become `shortcut`.
- `tf/state.ts`: option pages and menu commands hidden inside Taskforce; `isTfScriptsOff()`,
  `isTfTouch()`, the mind map registry for `tf/mobile`.
- `tf/history.ts`: note navigation adds no entries to the host tab's history (`pushState` becomes
  `replaceState` plus an entry in the frame's own list); `history.back()`, `forward()` and `go()`
  walk that list and fire `hashchange`, and the back/forward history menus read it. Installed
  before `appContext.start()` on an embed candidate page, removed when `/api/tf/bootstrap` does
  not answer.
- `tf/theme.ts` takes host colours as any CSS colour (bare `H S% L%` triplets as `hsl()`), sets
  `--tf-on-accent` to black or white for contrast, and accepts font stacks up to 400 characters.
  `tf/tf.css` maps the accent onto selection, focus, active rows and tabs, the navigator's active
  indicator, the calendar, CKEditor's pressed toolbar buttons and form controls, and bundles
  Source Sans 3 (`tf/fonts/`, OFL 1.1, from `@fontsource-variable/source-sans-3` 5.3.1), the face
  Taskforce sends in `fontSans`, which a frame cannot load from the host. Note content keeps
  the Next theme's Inter.

Touch layer (`tf/mobile/`, capability `tf-touch-1`, CSS under `:root.tf-embedded.tf-touch`):

- `touch.css`: 44 px hit areas, 8 px between the launch bar's buttons, hover-only controls shown,
  no hover look or tooltip left behind by a tap, `overscroll-behavior`, 16 px fields (no iOS zoom).
- `press.ts`: pressed look on touch down for every tappable control; on dense rows (CKEditor
  toolbars, `[role=toolbar]`, the launch bar) a finger resting 120 ms shows the button's name above
  it, sliding picks a neighbour (light `haptic` per step), lifting activates it, 28 px away from the
  row cancels; a finger moving 8 px before the 120 ms scrolls the row or swipes the tabs instead.
- `touch_session.ts`: every `touchstart` of the layer is passive; `touchmove`/`touchend`/`touchcancel`
  exist only while a press runs (passive) or a gesture owns the finger (blocking, on `window`), so a
  scroll never waits for a listener. A gesture that owns the finger also locks its scroller
  (`.tf-gesture-lock`, `overflow: hidden`, for WebKit, which decides cancelability at `touchstart`)
  and swallows the browser's click after it. Pinches stay passive: the note scrollers carry
  `touch-action: pan-x pan-y`. Covered by `touch_session.spec.ts`.
- `navigator_drag.ts`, `navigator_row_tools.tsx`, `tree_drag.ts`, `moves.ts`, `reorder.ts`,
  `drag_visuals.ts`: hold 350 ms to lift a row of the mobile navigator or a node of the note tree,
  insertion line, 500 ms rest to drop inside, auto-scroll near the edges, moves through
  `services/branches.ts`, an Undo toast; Escape or a drop at the origin cancels; a lift without a
  move opens the row's menu; each navigator row gets a 44 px More button. For assistive technology
  the row and the current-note tile stop being `role="button"`: an open button named after the
  note covers them, then add and More ("More for Launch plan"), in that focus order. The row menu's
  "Move to" is the non-drag way to move a note.
- `block_handle.ts`: a 44 px handle beside the block holding the caret drags the block; hidden (out of
  the tab order, `inert`, `aria-hidden`) and refusing to move anything while the editor is read-only.
- `text_size.ts`, `TextSizeRow.tsx`: pinch on a text or code note sets the reading size (80 to
  220 %, holds at 100 %), saved per person in `tfTextScale`; a "Text size" row in the note menu.
- `image_gestures.ts`: a double tap or pinch on an image in a text note opens the image viewer;
  in the viewer a double tap toggles 1x and 2.5x.
- `included_todos.ts`: a tap within 14 px of a to-do checkbox in an included note ticks it in
  that note through `POST /api/tf/todos/toggle` with the blob it read as `baseBlobId`, without
  focusing the editor around the include (Trilium shows included notes read-only); a toast instead
  while someone else has the turn on that note, the box back on a 409. In the edited note, to-do rows are 44 px tall and the checkbox's wrapper carries
  the 14 px margin `setupTodoCheckboxTaps()` needs as a target inside the list.
- `map_gestures.ts`: two-finger pinch and pan on mind maps, applied once per animation frame.
- `keyboard.ts`: on touch only, keeps the caret above the keyboard, the formatting toolbar and the
  recorder bar in both host modes (frame shrunk, or `keyboardInset` covering it) and keeps each
  scroller on the same block through a rotation.

Team layer (`tf/team/`, capabilities `tf-presence-1`, `tf-turns-1`, `tf-comments-1`, `tf-people-1`,
`tf-authors-1`, `tf-unread-1`), started by `installTfTeam()` before `ready`. Upstream files reach
it only through `tf/team/hooks.tsx` (`getTfTeamHook()`, `<TfTeamSlot name>`), which is light and
does nothing until the embedding registers into it:

- `store.ts`: people (`GET people`, once a session; the `@` lists filter it, the gateway is asked
  only when no name matches, each query once), `presence.list` and `lock` from `/__tf/rt`, comment threads
  (`GET comments`, `comment.*` events), open-thread counts, unread notes (`GET unread`, `unread`
  event, `badge` to the host), activity and revision authors. After the socket reconnects the
  people, the threads and authorship of the notes open in a tab, the unread notes and the comment
  counts load again; presence and turns come back through the `presence` the tracker sends again.
- `tracker.ts`: `presence { noteId, editing }` on note change and typing (an edit in the last
  3 s); the edit lock of the open text, code or Markdown note (`turns.ts`: request on the first
  edit, keep-alive every 2 s, release 5 s after the last one, on blur, note change and unload).
  Every own change of a text editor's model (`change:data` with an undoable local batch: typing,
  a checkbox, a person picked with the mouse, a moved block, a transcript) asks for the turn; one
  refused is undone (`undo` of that batch) and the turn bar shows who types; keys of code notes are
  refused before they apply. While someone else has the turn every editor of that note, in every
  tab and split, goes read-only (`enableReadOnlyMode("tf-turns")`, CodeMirror `setReadOnly(true)`);
  each lock is remembered with the editor and note context it was put on and lifted from exactly
  that editor when the turn ends, the context shows another note or the tab closes (re-evaluated
  on every turn, presence and note context change, and each second for rebuilt editors). Marks a
  note seen after 1.5 s on screen.
- `presence_ui.tsx`: the other people on the note in the title row; the turn bar under it ("NAME is
  typing. You can edit when they pause." with "Take over"; "NAME is also editing this. The last
  save wins." for other note types).
- `lists_ui.tsx`: "People here" and "What changed" in the launch bar and the phone navigator header.
- `marks.tsx`: presence dots, bold unread titles, accent dots and hollow ancestor dots on tree and
  navigator rows, with the names in the row's accessible name.
- `comments_ui.tsx`, `actions.tsx`: the Comments tab of the right pane and the phone note panel,
  "Comment" in the text editor's context menu, the block handle menu and the phone insert tiles,
  margin markers on blocks with open threads (measured at most once per animation frame, only
  while the split is shown, redrawn only when a position changed), the `@` people list in the
  composer (200 ms after the last key, older answers dropped).
- `editor_plugin.ts`: person mentions in note text, stored as
  `<span class="tf-mention" data-tf-person-id data-tf-person-name>@Name</span>`; the `@` list puts
  people first (`tf-person:<id>` picks); a mention shows the member's current name for its id
  ("Unknown person" for a non-member, never the stored name), pasted mentions of non-members become
  plain text. After each save `POST mentions` for the people named in this frame since the editor
  loaded the note (`MentionLedger`: content an editor loads, also after someone else's save, is
  known; a failed post sends only its own people again).
- `authors_ui.tsx`: "Edited by NAME, 5 min ago" in the title details and atop the comments; revision
  authors and a "By" filter in the revisions dialog.
- `window.__tfTeam` exposes `getTeam()` and `setTurnBypass()` for debugging and `scripts/tf-team-check.mjs`.

Work layer (`tf/work/`, capabilities `tf-reminders-1`, `tf-todos-1`, `tf-tasks-1`, `tf-chips-1`,
`tf-docx-1`), registered by `registerTfWorkCapabilities()` before `ready` and started by
`startTfWork()`. Upstream editor files reach it only through `tf/work/editor_host.ts`, which is
light; the rest loads once the page is embedded:

- Editor plugin `TfWork` (`packages/ckeditor5/src/tf/work/tf_work.ts`), inert without the
  `tfWork` config: Taskforce chips stored as `<a class="tf-chip" href data-tf-kind data-tf-id>title</a>`
  (an ordinary link to every other reader), a pasted Taskforce link turned into a chip as a second
  undo step, to-do items with a task chip ticking with the task, "Make task" and "Remind me" buttons.
  Stored chip HTML is a chip only when `parseLink()` takes its `href` for a Taskforce link of the
  stated kind and id; otherwise a web link stays a link saved with `rel="noopener noreferrer"` and
  anything else becomes its text.
- `editor_work.ts`, `chips.ts`: the host side of the plugin; chips resolve through `POST links/resolve`
  and follow `chip.updated`; a task's new state ticks its to-do items once: in the editor of the
  person who has the turn on the note, else through `POST /api/tf/todos/toggle` by the frame whose
  person's id sorts first among those on the note (the other editors reload, unsaved ones keep their
  text); a chip opens the path Taskforce answered or its checked link, never a raw `href`; a clock
  and a "Make task" action beside to-do items (an overlay outside the editable, drawn once per
  animation frame from to-do items read again only after a change that can touch them, and only
  while the editor is on screen); "Remind me…" and "Make task…" in the text menu and at a bare caret on a to-do item.
- `ReminderDialog.tsx`, `RemindersView.tsx`, `WorkComponents.tsx`: reminders through `/__tf/api/reminders`,
  the bell in the title row, "Reminders" and "To-dos" in the launch bar, `reminder.due` toasts.
- `TodosDialog.tsx` + core `tf/work/todos.ts`: the notebook's open to-do items, `GET /api/tf/todos`,
  ticked through `POST /api/tf/todos/toggle` (the note-save path; 409 on a stale `baseBlobId`).
- `MakeTaskDialog.tsx`: `POST tasks` with the note, the block and a `requestId` made when the dialog
  opens (a repeat answers the first task), one request at a time, the chip appended to the line.
- `export_word.ts` + core `tf/work/docx_source.ts` + server `tf/work/docx.ts` (`docx` library, lazy
  chunk): "Word document" in the export dialog and "Download as Word" in the note menu,
  `GET /api/tf/export/docx/:noteId[?children=1]`.

Reach layer (`tf/reach/`, capabilities `tf-voice-1`, `tf-share-1`, `tf-search-1`), installed by
`installTfReach()`. Upstream services and menus reach it only through `tf/reach/hooks.ts` (no widget
imports) and widgets through `tf/reach/components.tsx`; the editor configuration through
`tf/reach/voice/editor_config.ts`:

- `voice/`: "Voice note" after "Insert media" in every insert group, in the slash menu
  (`slashCommand.tfExtraCommands`), on the phone's formatting island and in the tree's new-note
  choices ("Record a voice note" makes a "Voice note, <date time>" child). `RecorderBar.tsx` is
  docked above the pane's bottom, the phone island, the keyboard inset and the safe area, placed on
  viewport, focus and resize events (no frame loop), never a modal (Escape hands the focus back to
  the note): level meter (AnalyserNode, at most 15 redraws a second, still for reduced motion or a
  hidden tab), Pause/Resume, Stop, Discard with a 5 s Undo. Screen readers hear state changes
  through one polite live region; the clock is in the bar's name only. `recorder.ts`: MediaRecorder with the first
  supported of `audio/webm;codecs=opus`, `audio/mp4;codecs=mp4a.40.2`, `audio/mp4`, `audio/webm`,
  mono, 32 kbps, a warning at 19:00 and a stop at 20:00, a wake lock, a pause when the page hides or
  the microphone goes. On Stop the paperclip's `fileUpload` (`asEmbed`) puts the attachment where
  the caret was at the start (a model marker), then `POST /__tf/api/voice/transcribe`; the text goes
  in as a collapsible "Transcript" block under the embed (as an edit that takes the turn, waiting up
  to a minute while someone else has it; with no editor open, into the saved note with its blob as
  `tf-base-blob`, read again and retried on a 409 up to three times, then a toast). `EmbedStatus.tsx` shows "Writing the
  transcript…" or why there is none, with "Try again" (the bytes are read back from the engine).
  "Make a transcript" in an audio embed's menu (25 MB, 20 min).
- `share/`: "Share link…" in the note menu opens `ShareDialog.tsx` (a bottom sheet on phones):
  live links (`GET/POST/PATCH/DELETE /__tf/api/share-links`), a link shown once with Copy and
  Share…, end date, password, Withdraw. `ShareMarker.tsx`: "Shared until <date>" in the title row.
  Upstream's share switch, share badge, share options and `#share*` help are hidden through
  `HIDDEN_UI` in `tf/state.ts`.
- `search/`: "In your other notebooks" under the quick search and the full search
  (`GET /__tf/api/search`, 250 ms debounce, hits with `here: true` dropped); a hit sends
  `open { href }` to the host.

## Upstream files touched

| File | Hook |
|---|---|
| `packages/trilium-core/src/becca/entities/abstract_becca_entity.ts` | `assertTfWritable()` in `save()`, `markAsDeleted()`, `markAsDeletedSimple()` (view role) |
| `packages/trilium-core/src/services/entity_changes.ts` | `assertTfWritable()` in `putEntityChange()`, the catch-all for raw SQL writes (view role) |
| `packages/trilium-core/src/services/options.ts` | per-person name resolution in `getOptionOrNull()`, `setOption()`, overlay in `getOptionMap()` |
| `packages/trilium-core/src/routes/api/options.ts` | a person's `locale` leaves the engine's own language alone |
| `packages/trilium-core/src/routes/api/notes.ts` | save guard in `updateNoteData()`, `{ blobId }` answer |
| `apps/server/src/app.ts` | `installTf(app)` |
| `apps/server/src/routes/route_api.ts` | identity into the execution context; 403 `{ tfReadOnly }` in `handleException()` |
| `apps/server/src/services/ws_messaging_provider.ts` | gateway key on upgrade, socket owner, per-person `frontend-update` |
| `apps/client/src/services/server.ts` | call interceptor, `tf` call options (extra headers, silenced statuses), explicit return type of `call()` |
| `apps/client/src/widgets/react/hooks.tsx` | records the blob an editor loaded (`setTfBaseBlob()`) |
| `apps/client/src/desktop.ts`, `apps/client/src/mobile.ts` | `maybeStartTf()` after start-up |
| `apps/client/src/layouts/desktop_layout.tsx`, `apps/client/src/layouts/mobile_layout.tsx` | Taskforce button, protected-notes notice |
| `apps/client/src/widgets/dialogs/about.tsx` | `<TfAboutLine />` |
| `apps/client/src/widgets/dialogs/OptionsDialog.tsx` | hidden option pages |
| `apps/client/src/widgets/buttons/global_menu.tsx` | hidden menu commands |
| `packages/trilium-core/src/routes/api/options.ts` | `isTfOwnOption()` in `isReadable()` (`tfTextScale`) |
| `packages/trilium-core/src/routes/api/script.ts` | `TF_SCRIPTS=off`: empty startup, widget and relation bundles, no bundle |
| `packages/trilium-core/src/services/scripting_guard.ts`, `apps/server/src/services/scripting_guard.ts` | `TF_SCRIPTS=off` turns backend scripting off |
| `apps/server/src/routes/index.ts` | `tfScriptsOff` in the page bootstrap |
| `apps/client/src/services/bundle.ts` | no startup scripts, widgets or render-note bundles while `tfScriptsOff` |
| `apps/client/src/widgets/launch_bar/LauncherContainer.tsx` | no custom-widget launchers while `tfScriptsOff` |
| `apps/client/src/widgets/launch_bar/HistoryNavigation.tsx` | back/forward menus read `getTfHistoryEntries()` |
| `apps/client/src/widgets/mobile_widgets/MobileNoteNavigator.tsx` | `<TfNavigatorRowTools />` in each row (open button, touch drag, More button), `<TfNavigatorTileTools />` after the current-note tile's title (open button, named add and More) |
| `apps/client/src/widgets/layout/NoteActions.tsx` | `<TfTextSizeRow />` in the note menu |
| `apps/client/src/widgets/type_widgets/mind_map/MindMap.tsx` | `registerTfMindMap()` for two-finger pinch and pan |
| `apps/client/src/widgets/react/ImageViewer.tsx` | on touch a double tap toggles the zoom instead of resetting it |
| `apps/client/src/layouts/desktop_layout.tsx`, `apps/client/src/layouts/mobile_layout.tsx` | `<TfTeamSlot name="title-row">` (presence, turn bar, comment markers), `launch-bar` (people here, what changed) |
| `apps/client/src/widgets/mobile_widgets/MobileNoteNavigator.tsx` | `navigator-header` and `navigator-row` slots |
| `apps/client/src/widgets/mobile_widgets/MobileNotePanel.tsx` | `useTfOpenNotePanel()`: opens on the Comments tab |
| `apps/client/src/widgets/note_tree.ts` | `treeRow` hook at the end of `enhanceTitle()` (presence and unread marks) |
| `apps/client/src/widgets/sidebar/RightPaneTabs.tsx` | the `tf-comments` tab id and entry |
| `apps/client/src/widgets/sidebar/RightPanelContainer.tsx` | `rightPaneWidgets` and `rightPaneTabBadge` hooks in `useRightPaneTabs()` |
| `apps/client/src/widgets/react/TabStrip.tsx` | optional `badge` on a tab (open-thread count) |
| `apps/client/src/widgets/react/NoteAutocomplete.tsx` | `NoteMentionList` lists people first (`withTfMentionPeople()`), "People" and "Notes" headings |
| `apps/client/src/widgets/type_widgets/text/config.ts` | `extraPlugins` from `tfTeamEditorPlugins()` (person mentions, the Comment tile) |
| `apps/client/src/widgets/type_widgets/text/toolbar.ts` | `tfComment` in the phone toolbar's insert tiles |
| `apps/client/src/menus/note_context_menu.ts`, `apps/client/src/services/block_reference.ts` | "Comment" in the text editor's menu and the block handle menu |
| `apps/client/src/widgets/dialogs/revisions.tsx` | revision author per row, "By" filter |
| `apps/client/src/widgets/layout/InlineTitle.tsx` | `title-details` slot ("Edited by …") |
| `packages/ckeditor5/src/plugins.ts`, `packages/ckeditor5/src/index.ts` | `TfWork` in `COMMON_PLUGINS` (inert without `tfWork`), exported |
| `apps/client/src/widgets/type_widgets/text/CKEditor.tsx` | `whenTfEditorReady()` before the config, `applyTfEditorConfig()` after |
| `apps/client/src/widgets/type_widgets/text/toolbar.ts` | `getTfWorkToolbarItems()` in the phone toolbar's insert tiles |
| `apps/client/src/layouts/desktop_layout.tsx`, `apps/client/src/layouts/mobile_layout.tsx` | `<TfNoteWorkBadges />` in the title row, `<TfWorkLaunchButtons />` in the launch and bottom bars |
| `apps/client/src/widgets/layout/NoteActions.tsx` | `<TfWorkNoteMenuItems />` ("Remind me…", "Download as Word") |
| `apps/client/src/widgets/dialogs/export.tsx` | `withTfExportFormats()`, `tfExportResultText()`, `tfExportBranch()` (Word) |
| `apps/client/src/menus/note_context_menu.ts` | `getTfWorkContextMenuItems()` ("Remind me…", "Make task…") |
| `apps/server/src/tf/routes.ts` | `registerTfWorkRoutes()` |
| `packages/ckeditor5/src/index.ts` | exports `ButtonView` for the Voice note toolbar item |
| `packages/ckeditor5/src/plugins/mention/slash_commands.ts` | `slashCommand.tfExtraCommands` joins the catalog (Voice note) |
| `apps/client/src/widgets/type_widgets/text/config.ts` | `tfReachEditorConfig()` around the built config (toolbar item, slash command) |
| `apps/client/src/widgets/type_widgets/text/ContentEmbed.tsx` | `<TfEmbedStatus />` under an attachment embed (transcript status) |
| `apps/client/src/menus/link_context_menu.ts` | `tfAttachmentEmbedItems()` ("Make a transcript") in `getAttachmentItems()` |
| `apps/client/src/services/note_types.ts` | `tfNoteTypeItems()` ("Record a voice note") in the first group |
| `apps/client/src/widgets/type_widgets/options/password.tsx` | inside Taskforce the Password page shows only "change password" and the protected-session timeout: `isTfHiddenUi("signInMethod")` and `isTfHiddenUi("passwordReset")` hide the sign-in method and the reset |
| `apps/client/src/menus/tree_context_menu.ts` | `tfHandleTreeMenuItem()` runs that choice; `tfReorderMenuItems()` adds "Move up" and "Move down" on a phone (`tf/mobile/row_reorder.ts`: the way to change the order without dragging) |
| `apps/client/src/widgets/layout/NoteActions.tsx` | `<TfShareLinkRow />`; the `shared` switch hidden by `useTfHiddenUi("shareSwitch")` |
| `apps/client/src/widgets/layout/NoteBadges.tsx` | `<TfShareMarker />`; `ShareBadge` hidden by `useTfHiddenUi("shareBadge")` |
| `apps/client/src/widgets/note_tree.ts` | `tfSharedTreeTooltip()` for shared rows |
| `apps/client/src/widgets/attribute_widgets/attribute_detail.tsx` | `tfAttributeHelp()` for `#share*` labels |
| `apps/client/src/widgets/type_widgets/options/other.tsx` | share settings hidden by `isTfHiddenUi("shareOptions")` |
| `apps/client/src/widgets/quick_search.tsx` | `<TfOtherNotebooks variant="menu" />` under the results |
| `apps/client/src/widgets/search_result.tsx` | `<TfOtherNotebooks variant="list" />` under the results, also when there are none here |
| `scripts/tf-dev-host.mjs` | the frame's `allow` includes `microphone; camera` |
| `packages/trilium-core/src/routes/api/options.ts` | refused options (`assertTfOptionWritable()`, also before a batch), `tfReportedOptions()` in `getOptions()`, no user themes with scripts off |
| `packages/trilium-core/src/services/scripting_guard.ts` | no SQL console when embedded |
| `packages/trilium-core/src/services/sync_options.ts` | `isSyncSetup()` false when embedded |
| `packages/trilium-core/src/services/sync.ts` | no sync timer, `syncRequest()` throws when embedded |
| `packages/trilium-core/src/services/llm/index.ts` | `createProviderInstance()` refuses when embedded |
| `packages/trilium-core/src/services/llm/providers/fetch.ts` | `llmFetch()` refuses when embedded |
| `packages/trilium-core/src/services/bootstrap_utils.ts` | no `#appCss` notes and no user-made theme with scripts off |
| `packages/trilium-core/src/share/handlers.ts` | `tfRawShareHeaders()` on raw share content and the view route |
| `packages/trilium-core/src/routes/api/branches.ts` | `setTfBranchesExpanded()`, `getTfBranchExpanded()`: expansion per person |
| `packages/trilium-core/src/routes/api/tree.ts` | `getTfBranchExpanded()` in the tree load |
| `apps/server/src/routes/index.ts` | `tfEmbed` in the page bootstrap |
| `apps/server/src/services/safe_fetch.ts` | `tfOutboundFetch()` instead when embedded |
| `apps/server/src/services/request.ts` | `tfOutboundGetImage()` instead of `getImage()` when embedded |
| `packages/trilium-core/src/routes/api/notes.ts` | save guard and `{ blobId }` answer in `updateNoteBlocks()` |

## Per-person options

Defined and explained in `packages/trilium-core/src/tf/options.ts` (`TF_PER_USER_OPTIONS`):

| Option | Why per person |
|---|---|
| `openNoteContexts`, `hoistedNoteId` | open tabs and the entered workspace are navigation state |
| `theme` | driven by each person's Taskforce light or dark mode |
| `locale`, `formattingLocale`, `firstDayOfWeek`, `firstWeekOfYear`, `minDaysInFirstWeek` | display language and calendar layout |
| `zoomFactor`, font sizes and families, `overrideThemeFonts` | reading comfort |
| `leftPaneWidth`, `leftPaneVisible`, `rightPane*`, `presentationSidebarVisible` | pane sizes and visibility |
| `layoutOrientation`, `splitEditorOrientation` | screen layout |
| `motionEnabled`, `shadowsEnabled`, `backdropEffectsEnabled`, `smoothScrollEnabled` | visual effects, accessibility |
| `maxContentWidth`, `centerContent`, `headingStyle` | how content is drawn, not what is stored |
| `treeDensity`, `autoCollapseNoteTree`, `treeScrollFollowNavigation` | tree behaviour |
| `codeBlockTheme*`, `codeNoteTheme*` | syntax colours follow the person's theme |
| `contentManagerViewMode`, `contentManagerSortOrder`, `editedNotesOpenInRibbon` | list and ribbon state |
| `vimKeymapEnabled`, `codeLineWrapEnabled`, `codeLineNumbersEnabled`, `textNoteEditorType`, `textNoteEditorMultilineToolbar` | editor display and keys |
| `spellCheckEnabled`, `spellCheckLanguageCode` | the person's spelling language |
| `seenCallToActions`, any name ending in `Collapsed` | dismissed hints, collapsed sections |

Shared on purpose: everything that changes stored content or document behaviour (revision and
erase intervals, protected session timeout, typing replacements, date/time format, content
languages, allowed HTML, images, AI, OCR, sync, backup, password, MFA) and keyboard shortcuts.

## Tests

```bash
export PATH=~/apps/office-forks/tools/pnpm12/node_modules/.bin:$PATH
pnpm --filter server exec vitest run src/tf/ ../../packages/trilium-core/src/tf/   # server + core on Node
pnpm --filter standalone exec vitest run tf/tf_core                                  # core on sqlite-wasm
pnpm --filter @triliumnext/client exec vitest run src/tf/                            # bridge, save guard, history, theme, gestures, team
pnpm --filter @triliumnext/ckeditor5 exec vitest run src/tf/                        # TfWork editor plugin (browser; CHROME_BIN if needed)
```

The team features run against the real stack (Taskforce web, API and notes gateway) with two
people of a throw-away workspace, the installed `current` engine build:

```bash
node scripts/tf-team-check.mjs [--shots <dir>] [--only <check name part>] [--keep]
```

The work features the same way (reminders, roll-up, Make task, chips, Word export, phone):

```bash
node scripts/tf-work-check.mjs [--shots <dir>] [--keep]
```

The reach features the same way (voice notes with a fake microphone playing spoken words, share
links, a view person through a minted view token, search in a second notebook, phone, dark mode):

```bash
node scripts/tf-reach-check.mjs [--shots <dir>] [--only voice,transcript,denied,share,view,search,phone,dark] [--keep]
```

Touch checks run against a local stand-in for the gateway and the Taskforce page:

```bash
node scripts/tf-dev-host.mjs &            # engine :9781, frame proxy :9782, host page :9783
node scripts/tf-phone-check.mjs           # phone 402 x 874 and tablet 1024 x 768, touch; --only <groups>
node scripts/tf-touch-audit.mjs           # hit areas under 44 px, overlaps, hover-only controls
```

`apps/server/src/tf/tf_embed.spec.ts` boots the real app with `TF_EMBED=1` and covers the key
check, identity, per-person options for two people, every mutating route family for the view
role, the save guard (including the same person on two clients), the refused routes and options,
custom CSS with scripts off, per-person tree expansion, events received by a local HTTP server,
the bootstrap and the protected session. `route_policy.spec.ts` covers the canonical path rules,
`outbound.spec.ts` the address classifier and real fetches against a local listener, core
`tf/policy.spec.ts` the raw share headers.

## Install a build for the gateway

```bash
scripts/tf-install-local.sh [suffix]   # default suffix: next free devN
```

Builds `apps/server/dist`, copies it to
`${NOTES_ENGINE_DIR:-~/apps/office-forks/trilium-engines}/<upstream>_tf.<suffix>/` with a
`tf-version.json`, and moves `manifest.json`'s `current` to `previous`. `TF_SKIP_BUILD=1` installs
the existing build.

## Taskforce Notes, the desktop app (`TF_DESKTOP=1`)

An Electron build of this fork that keeps the notes of one Taskforce notebook on a Mac and syncs
them with the engine through the notes gateway. The contract (connect flow, gateway routes, the
update feed, the build folder) is `infra/notes/DESKTOP.md` in the Taskforce repository.

The flavour is baked in at build time (`scripts/build-utils.ts` `tfDesktopDefines()`): with
`TF_DESKTOP` unset at build time every hook below is a no-op and the desktop app is upstream's.

- Own name, bundle id (`TF_DESKTOP_BUNDLE_ID`, default `org.triliumtf.notes`), data folder
  (`~/Library/Application Support/Taskforce Notes`, `TF_NOTES_DATA_DIR` for tests), port 37851
  (`TF_NOTES_PORT`) and URL scheme `taskforce-notes:`, so it runs next to a stock Trilium.
  `apps/server/src/tf/desktop_env.ts` claims the folder inside `data_dir.ts`, before anything
  resolves it, and refuses any folder of a stock Trilium.
- Connect screen (`apps/client/src/tf/desktop/connect.tsx`) while there is no device key: paste
  or open a connect link, the gateway's `update` answer decides the screen (ready, another app
  version, bring the notes of the Trilium app on this Mac along), `redeem` gives the device key and
  the seed, and the first sync runs as upstream's. A link of another notebook keeps the notes here
  as a backup file in `backup/` and restarts empty.
- Bringing the Trilium notes along: the stock database is copied byte for byte into a private
  staging copy (a read-only SQLite open of a WAL database writes side files next to it), written
  out with the SQLite backup API and sent to `POST /__tf/desktop/replace` in parts of 64 MiB.
- Every sync request carries `x-tf-device`; `/api/setup/status` is skipped on login (the gateway
  passes the sync routes only). A 401 `device_revoked`, a 403 `not_eligible` or another sync
  version stops the sync loop until the person acts; the client shows a notice.
- The device key and its companions (`tfDeviceToken`, `tfDeviceId`, `tfNotebookName`,
  `tfUserName`, `tfLastSyncAt`) are not-synced options, never readable through `/api/options`,
  and a pulled change to them is dropped.
- Settings > Sync shows the connection and "Disconnect this Mac"; upstream's update check and
  proxy settings are hidden. Updates come from the notebook (Squirrel.Mac,
  `<notebook>/__tf/desktop/squirrel?build=N` with `x-tf-device`), at start and hourly.
- No UI text shows an address, a link, a file path or a raw error: the main process logs them.

| File | Hook |
|---|---|
| `apps/desktop/src/main.ts` | `./tf/prelude` first; `initTfDesktopMain()`, `handleTfSecondInstance()`, `tfDesktopOnReady()` |
| `apps/desktop/src/app-info.ts`, `apps/desktop/scripts/build.ts`, `apps/desktop/electron-forge/forge.config.ts` | product name, packager config (bundle id, build number, scheme, signing) |
| `apps/desktop/src/preload.ts`, `packages/commons/src/lib/electron_api_interface.ts` | `window.electronApi.tfDesktop` |
| `apps/desktop/src/services/window.ts` | `getSetupWindow()` |
| `apps/server/src/services/data_dir.ts` | `claimTfDesktopEnv()` |
| `apps/server/src/services/request.ts`, `packages/trilium-core/src/services/request.ts` | `ExecOpts.headers`; the gateway's `{ error }` in the message |
| `apps/server/src/routes/index.ts` | `tfDesktop` in the Electron renderer's bootstrap |
| `packages/trilium-core/src/services/sync.ts`, `setup.ts`, `sync_options.ts`, `sync_update.ts` | device key header, sync stop, no `setup/status`, dropped option changes |
| `apps/client/src/index.ts`, `desktop.ts` | connect screen entry, notices |
| `apps/client/src/widgets/type_widgets/ContentWidget.tsx`, `options/other.tsx`, `widgets/buttons/global_menu.tsx` | Settings > Sync page, no upstream update check |
| `scripts/build-utils.ts` | `tfDesktopDefines()` |

Tests:

```bash
(cd apps/desktop && ../../node_modules/.bin/vitest run src/tf/)    # link, gateway, updater, stock copy, fresh start, flavour
(cd apps/server && ../../node_modules/.bin/vitest run src/tf/desktop_env ../../packages/trilium-core/src/tf/desktop)
(cd apps/standalone && ../../node_modules/.bin/vitest run tf/desktop)   # core on sqlite-wasm
(cd apps/client && ../../node_modules/.bin/vitest run src/tf/desktop)
```

End to end, against a stock engine behind a stand-in for the gateway, with a throwaway "stock
Trilium" database, every screen photographed in the light and the dark appearance with a contrast
reading:

```bash
TF_DESKTOP=1 TF_DESKTOP_BUILD=1 pnpm --filter desktop build
node apps/desktop/e2e-tf/run.mjs <work dir> <engine port> <stock port> <gateway port> <app port>
```

The app icon and the installer disk's icon come from `TF_DESKTOP_ICON_DIR` (`icon.icon`, `icon.icns`,
`volume.icns`; `electron-forge/tf-desktop.ts`), so no logo lives in this repository; without it the
build keeps upstream's icons. `electron-forge/dmg-icon/generate.mts --mark <image> --out <file.icns>`
renders a disk icon around another mark.

Signed and notarized build (macOS arm64), written to `apps/desktop/out/tf-desktop/<version>/`
with `meta.json`:

```bash
TF_DESKTOP_BUILD=<n> TF_SIGN_IDENTITY="Developer ID Application: …" TF_NOTARY_PROFILE=<profile> \
    TF_DESKTOP_ICON_DIR=<folder> node scripts/tf-desktop-build.mjs [--out <dir>] [--unsigned]
```
