# A Post's "title was hand-edited" flag is a persisted column, not app-only state

Title defaults to Description's first sentence and keeps auto-following it as Description changes -- until the user hand-edits Title, at which point it stops auto-deriving and keeps exactly what they typed. `posts.title_manual` (`INTEGER`, `NOT NULL DEFAULT 0`) records which state a Post is in.

The simpler alternative -- keeping that flag as in-memory app state only, reset to "auto" every time a Post is loaded from the DB -- was considered and rejected. It would silently drop the "don't overwrite what I typed" protection on every app restart: the user hand-edits a Title, closes the app, reopens it, edits the Description for some unrelated reason, and their Title gets silently clobbered. That failure is surprising and easy to miss until it's already happened. A single persisted boolean is cheap enough that there's no real tradeoff here.

Resolved on [issue #3](https://github.com/max-lutz/instagram-organizer/issues/3).
