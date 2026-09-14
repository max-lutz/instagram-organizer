# Posts use a surrogate integer id, not the link, as primary key

CONTEXT.md defines a Post as "identified by its Instagram link," and `link` carries a `UNIQUE` constraint — the obvious move would be to make it the primary key. Instead, `posts.id` is a surrogate `INTEGER PRIMARY KEY AUTOINCREMENT`, with `link` as a separate unique column.

The link is user-editable (the edit modal lets you fix a broken or changed URL), so a mutable value shouldn't double as the primary key. A stable surrogate id also gives future work — e.g. a prospective local media/video store — something durable to reference regardless of link edits. Resolved on [issue #3](https://github.com/max-lutz/instagram-organizer/issues/3).
