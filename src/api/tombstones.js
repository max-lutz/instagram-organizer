// Deletion tombstones (issue #30/#40): snapshot a Post's fields, its
// Collection's name, and its Tags (denormalized JSON) into deleted_posts
// before a hard delete, so a later reimport can recognize it instead of
// treating it as brand new. Shared by every hard-delete call site
// (posts.js, collections.js, backup.js) so the snapshot shape stays uniform.
function createTombstones(db) {
  // One row per link (deleted_posts.link is UNIQUE) -- OR REPLACE overwrites
  // any prior tombstone for the same link, per #30's decision.
  const insertTombstone = db.prepare(
    `INSERT OR REPLACE INTO deleted_posts
      (link, title, description, note, owner_name, owner_username, collection_name, tags, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Reads posts.* rows plus their current Collection name and Tag names, and
  // returns the snapshot rows without writing them -- split out from
  // tombstonePosts so backup.js's restore can compute snapshots against the
  // pre-restore DB state, then write them after the restore-wipe has run.
  function buildTombstoneRows(posts) {
    if (posts.length === 0) return [];

    const collectionIds = [...new Set(posts.map((p) => p.collection_id).filter((id) => id !== null))];
    const collectionNameById = new Map();
    if (collectionIds.length > 0) {
      const placeholders = collectionIds.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id, name FROM collections WHERE id IN (${placeholders})`)
        .all(...collectionIds);
      for (const row of rows) collectionNameById.set(row.id, row.name);
    }

    const placeholders = posts.map(() => '?').join(',');
    const tagRows = db
      .prepare(
        `SELECT pt.post_id AS post_id, t.name AS name
         FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.post_id IN (${placeholders})
         ORDER BY t.name COLLATE NOCASE ASC`
      )
      .all(...posts.map((p) => p.id));
    const tagNamesByPost = new Map();
    for (const row of tagRows) {
      if (!tagNamesByPost.has(row.post_id)) tagNamesByPost.set(row.post_id, []);
      tagNamesByPost.get(row.post_id).push(row.name);
    }

    const now = Date.now();
    return posts.map((post) => ({
      link: post.link,
      title: post.title,
      description: post.description,
      note: post.note,
      owner_name: post.owner_name,
      owner_username: post.owner_username,
      collection_name: post.collection_id !== null ? collectionNameById.get(post.collection_id) ?? null : null,
      tags: JSON.stringify(tagNamesByPost.get(post.id) || []),
      deleted_at: now,
    }));
  }

  function insertTombstoneRows(rows) {
    for (const row of rows) {
      insertTombstone.run(
        row.link,
        row.title,
        row.description,
        row.note,
        row.owner_name,
        row.owner_username,
        row.collection_name,
        row.tags,
        row.deleted_at
      );
    }
  }

  // posts: array of posts.* rows (must include collection_id).
  function tombstonePosts(posts) {
    insertTombstoneRows(buildTombstoneRows(posts));
  }

  // Manual re-add invariant (#30): a tombstone only exists for a link that
  // isn't currently live, so re-adding a Post via its link clears it.
  function clearTombstone(link) {
    db.prepare('DELETE FROM deleted_posts WHERE link = ?').run(link);
  }

  return { tombstonePosts, buildTombstoneRows, insertTombstoneRows, clearTombstone };
}

module.exports = { createTombstones };
