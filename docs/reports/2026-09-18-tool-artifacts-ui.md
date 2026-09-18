Done. Committed on `feat/ta-ui` (d127dca, 5c6548d).

**What I built**
- `apps/desktop/src/transport.ts`: `toolArtifactBlobUrl(id)` — authed blob fetch from `GET /api/v1/tool_artifacts/{id}`, exact mirror of the attachment download mechanism (bearer token → blob → anchor `download` click → revoke). Also mirrored `artifact_id` onto the `tool_result` event type.
- `apps/desktop/src/views/WebChat.tsx`: on `tool_result` events whose `meta.card` is an artifact card, the tool frame body renders an `ArtifactDownloadCard` instead of the raw pointer text — type icon, filename, human size, mime, model-facing path as a muted subline, and a Download button (spinner while busy, Retry after a failed fetch). Styling mirrors the user-attachment chip family. `artifactCardOf()` (exported) narrows `meta.card` safely — malformed cards fall back to the old widgets.

**Verification**
- `vitest`: 81/81 pass, including two new pure tests (narrowing + meta propagation). There is no DOM/component test setup here (vitest is pure-logic only), so pixel-level rendering is pending manual check — noted as such.
- `vite build` succeeds; my code introduces zero typecheck errors.

**Deviations / notes**
- The server-embedded frontend **is** this app — `crates/server/src/http/web.rs` embeds `apps/desktop/dist` — so one implementation covers :18080 and Tauri. No mirroring needed.
- The card accepts both `{card:"artifact",…}` and `{kind:"artifact",…}` as the discriminator: your task text said `kind`, the shape you gave says `card`. Cheap to accept both; server lane will match one.
- Pre-existing breakage, not mine: the branch tip (and master) fails `tsc --noEmit` with 6 errors — `WebChat.tsx` references `project.folder`, `prep.instructions`, and a 9-arg `prepareTurn` whose types exist only as uncommitted changes in the `~/guild` checkout's dirty tree. Because of this, `npm run build` (which runs tsc) fails on the branch regardless of my work; whoever owns that lane needs to commit the pending `projects.ts`/`transport.ts` changes. Worktree node_modules came from a symlink to `~/guild/node_modules`, per the task.
