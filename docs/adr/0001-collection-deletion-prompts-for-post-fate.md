# Deleting a Collection asks whether to delete its Posts too

A Post belongs to at most one Collection. When the user deletes a Collection, the app asks them to choose: keep the Posts (they return to "To sort") or delete the Posts along with the Collection.

The FK stays `collection_id -> collections.id ON DELETE SET NULL` as the DB-level default -- it's the safe behavior if a Collection row is ever removed outside this explicit flow. The "also delete the Posts" path is handled at the app level: the app deletes the Collection's Posts first, then the Collection.

Earlier drafted as an unconditional "Posts always survive" rule (a Post is content the user chose to save; a Collection is just an organizing label), but the user wants the choice available per-deletion rather than a fixed policy -- some Collections really do hold Posts nobody wants to keep once the Collection itself is gone. Flagged as an open gap during frontier-mapping and resolved on [issue #3](https://github.com/max-lutz/instagram-organizer/issues/3).
