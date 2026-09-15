# Posts use a surrogate integer id, not the link, as primary key

CONTEXT.md defines a Post as "identified by its Instagram link," and `link` carries a `UNIQUE` constraint — the obvious move would be to make it the primary key. Instead, `posts.id` is a surrogate `INTEGER PRIMARY KEY AUTOINCREMENT`, with `link` as a separate unique column.

A stable surrogate id gives future work — e.g. a prospective local media/video store, or the `post_tags` join table — something durable to reference that doesn't depend on `link`'s value. Resolved on [issue #3](https://github.com/max-lutz/instagram-organizer/issues/3).

**Amendment**: the original reasoning here also cited the link being user-editable (via an edit modal) as a reason a mutable value shouldn't double as the primary key. That's no longer the case — `link` is now immutable after a Post is created (app-level only, no DB enforcement; see issue #3's amendment). The conclusion above is unaffected — a surrogate id is still the better choice regardless of `link`'s mutability — but the original premise no longer holds, so it's corrected here rather than left stale.
