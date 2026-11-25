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

Server (env: `TF_GATEWAY_KEY`, `TF_NOTEBOOK_ID`, `TF_PARENT_ORIGINS`, `TF_EVENTS_URL`):

- Every HTTP request and WebSocket upgrade needs `x-tf-gateway-key` = `TF_GATEWAY_KEY`
  (constant-time compare), else 403. `GET /api/health-check` stays open from loopback.
- `x-tf-user-id`, `x-tf-user-name` (URI-encoded) and `x-tf-role` become the request identity
  (`getTfUser()` in `packages/trilium-core/src/tf/identity.ts`). A malformed user id is 400.
- Per-person options (table below) are read and written as `tfu.<userId>.<name>`, with the shared
  value as the fallback. `/api/options`, `/bootstrap` and WebSocket `frontend-update` messages are
  personal: nobody receives another person's `tfu.*` rows.
- `role = view`: entity writes throw `TfReadOnlyError`, answered as 403 `{ tfReadOnly: true }`.
  A viewer still writes their own options, recent notes and tree expansion.
- Save guard on `PUT /api/notes/:noteId/data` with `x-tf-base-blob` (409 on a stale save by someone
  else, `*` forces the write after keeping the current content as a revision); success answers
  `{ blobId }`.
- Change events are batched (at most one POST a second, three tries, never blocking a save) to
  `TF_EVENTS_URL` with the gateway key.
- `GET /api/tf/bootstrap` and `GET /api/tf/protected`.

Client (active only inside a frame and only when `/api/tf/bootstrap` answers):

- `tf/bridge.ts`: the frame ↔ host protocol 1, `registerCapability()`.
- `tf/gateway.ts`: `tfFetch()` for `/__tf/api/*`, `tfRealtime()` for `/__tf/rt`, session renewal
  after a 401 (`session.expired` → `session.refresh` → `POST /__tf/refresh`, one retry).
- `tf/save_guard.tsx`: sends `x-tf-base-blob`, shows the conflict dialog (Keep both, Use theirs,
  Use mine), one toast for read-only refusals.
- `tf/theme.ts` + `tf/tf.css`: host light/dark (through the per-person `theme` option), accent,
  corner radius and UI font mapped onto the Next theme's variables; host viewport onto
  `--safe-area-inset-*` and the keyboard state `root_container.ts` uses.
- `tf/components.tsx`: the Taskforce button (top of the vertical launch bar, first item of the
  horizontal and mobile bars), the protected-notes notice in the title row, the About line.
- `tf/capture.ts`: links to a parent origin become `open`, host shortcuts become `shortcut`.
- `tf/state.ts`: option pages and menu commands hidden inside Taskforce.

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
pnpm --filter @triliumnext/client exec vitest run src/tf/                            # bridge, capture, save guard
```

`apps/server/src/tf/tf_embed.spec.ts` boots the real app with `TF_EMBED=1` and covers the key
check, identity, per-person options for two people, every mutating route family for the view
role, the save guard, events received by a local HTTP server, the bootstrap and the protected
session.

## Install a build for the gateway

```bash
scripts/tf-install-local.sh [suffix]   # default suffix: next free devN
```

Builds `apps/server/dist`, copies it to
`${NOTES_ENGINE_DIR:-~/apps/office-forks/trilium-engines}/<upstream>_tf.<suffix>/` with a
`tf-version.json`, and moves `manifest.json`'s `current` to `previous`. `TF_SKIP_BUILD=1` installs
the existing build.
