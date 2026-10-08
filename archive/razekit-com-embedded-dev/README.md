# Archive: the DEV engine that was built inside razekit.com

This is the verbatim source of `razekit.com` PR #2 (`d1ec367`, branch
`backup/pr2-embedded-dev`), which built a second DEV engine inside the
marketplace server and was never merged.

It is **reference only**. Nothing here is built, imported or tested: it depends
on the marketplace server (Express app, Prisma ledger, marketplace auth, email
and storage) that DEV no longer uses. What each module became is recorded in
[`docs/migration/inventory.md`](../../docs/migration/inventory.md); the parts
only this code had are ported into `src/`.
