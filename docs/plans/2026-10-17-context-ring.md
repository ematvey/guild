# Composer context ring — 0.5.75

The composer shows an 18px ring immediately left of the model picker. No
percentage or token text occupies the composer row. Hovering or focusing the
ring reveals the count, capacity, percentage and measurement scope. At 80%
it becomes amber; at 95% it uses the destructive color. A dashed ring means
usage is unknown, rather than zero.

The owner-scoped `GET /api/v1/threads/:id/context?model=…` reads the latest
successful durable assistant entry after the newest reset/compaction head.
Pi AI's accounting includes input, cached reads/writes and the completed
response. It reports the last completed request plus response, not an
estimate of a draft or unconsumed tool results. The selected route supplies
capacity; its unset limit follows the harness's 128,000-token fallback.
Changing models keeps the measured source model visible in the tooltip.

The read neither starts nor wakes a conversation worker. Committed history
revisions refresh the indicator; streaming text alone does not. Requests are
cancelled when the thread, model or revision changes. Results from another
thread/model cannot paint into the current composer.

Verification:

- Nine focused server checks pass, including the real Postgres read,
  cached-token totals with/without the aggregate, head invalidation, failed
  responses, model switching and ownership/tenant isolation.
- All 354 desktop tests, server typecheck and frontend build pass.
- A real browser turn completed `CONTEXT_RING_OK`. The live endpoint and ring
  agreed on 4,366 / 262,144 tokens (rounded to 2%).
- DOM checks confirmed an 18px SVG in a 28px focus target inside the composer,
  directly before the model picker, with no visible text. Keyboard focus
  exposes the tooltip. Reload and back navigation restore the measurement;
  a fresh thread shows unknown usage. At a 390px viewport the ring/picker
  remain aligned and document width is 390px.
- Dev health reports 0.5.75. The live `/assets/index-B10_Gm6s.js` matches the
  container byte-for-byte (SHA-256
  `51557f2d562df226a065b055a37ff1478f24934760f81955c3f1474bb5064d53`).
- All six updater-signed artifacts are published to dev. Local and public
  (`guild.example.com`) updater manifests advertise 0.5.75 for all four
  platforms. A public Windows installer download matches SHA-256
  `d1c62c9bb24ab70d58158e0c97fa193c3dd2d050e97c1304e7bb4e19d3f576c0`
  and passes Ed25519 verification. Builds/publication ran successfully as
  `bigjob-20261016-235713-context-clients`.

Implementation was created in `guild-wt/composer-context-ring`
on `feat/composer-context-ring`, then fast-forwarded into `develop` for dev
deployment and client publication. Production was untouched.
