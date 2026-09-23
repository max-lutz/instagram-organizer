// JSON API for backup/restore (issue #3's settled format, issue #15). A flat,
// normalized mirror of the DB tables -- ids preserved so collection_id/tag_ids
// resolve on restore. Restore is a full wipe-and-replace, kept a separate code
// path from the additive Instagram-export import flow (map #10 Notes).
const { HttpError } = require('./http-error');

// Bumped from issue #3's schema_version 2 to add owner_name/owner_username,
// which posts gained after that resolution (map #10 Notes) and would
// otherwise be lost on a restore.
const SCHEMA_VERSION = 3;

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array`);
  return value;
}

function createBackupApi(db) {
  function backupPosts() {
    const rows = db.prepare('SELECT * FROM posts ORDER BY id').all();
    const tagRows = db.prepare('SELECT post_id, tag_id FROM post_tags ORDER BY post_id, tag_id').all();
    const tagIdsByPost = new Map();
    for (const row of tagRows) {
      if (!tagIdsByPost.has(row.post_id)) tagIdsByPost.set(row.post_id, []);
      tagIdsByPost.get(row.post_id).push(row.tag_id);
    }
    return rows.map((p) => ({
      id: p.id,
      link: p.link,
      collection_id: p.collection_id,
      title: p.title,
      title_manual: p.title_manual,
      description: p.description,
      note: p.note,
      owner_name: p.owner_name,
      owner_username: p.owner_username,
      source: p.source,
      provenance: p.provenance,
      created_at: p.created_at,
      updated_at: p.updated_at,
      tag_ids: tagIdsByPost.get(p.id) || [],
    }));
  }

  function download() {
    const collections = db
      .prepare('SELECT id, name, note, color, created_at, updated_at FROM collections ORDER BY id')
      .all();
    const tags = db.prepare('SELECT id, name, color, created_at, updated_at FROM tags ORDER BY id').all();
    return { body: { schema_version: SCHEMA_VERSION, collections, tags, posts: backupPosts() } };
  }

  // Wipe-and-replace, but wrapped in one transaction: if any row in the
  // incoming arrays fails to insert (bad shape, FK violation), ROLLBACK
  // restores the pre-restore data instead of leaving the DB half-wiped.
  function restore({ body }) {
    if (body.schema_version !== SCHEMA_VERSION) {
      throw new HttpError(
        400,
        `Unsupported backup schema_version: ${body.schema_version}. Expected ${SCHEMA_VERSION}.`
      );
    }
    const collectionsIn = requireArray(body.collections, 'collections');
    const tagsIn = requireArray(body.tags ?? [], 'tags');
    const postsIn = requireArray(body.posts, 'posts');

    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM post_tags');
      db.exec('DELETE FROM posts');
      db.exec('DELETE FROM tags');
      db.exec('DELETE FROM collections');

      const insertCollection = db.prepare(
        'INSERT INTO collections (id, name, note, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const c of collectionsIn) {
        insertCollection.run(c.id, c.name, c.note ?? null, c.color, c.created_at, c.updated_at);
      }

      const insertTag = db.prepare(
        'INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      );
      for (const t of tagsIn) {
        insertTag.run(t.id, t.name, t.color, t.created_at, t.updated_at);
      }

      const insertPost = db.prepare(
        `INSERT INTO posts
          (id, link, collection_id, title, title_manual, description, note, owner_name, owner_username, source, provenance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      // Backup posts carry each attached tag as a bare id (tag_ids), not a
      // per-attachment timestamp, so post_tags.created_at is stamped fresh here.
      const insertPostTag = db.prepare('INSERT INTO post_tags (post_id, tag_id, created_at) VALUES (?, ?, ?)');
      const now = Date.now();
      for (const p of postsIn) {
        insertPost.run(
          p.id,
          p.link,
          p.collection_id ?? null,
          p.title ?? null,
          p.title_manual ? 1 : 0,
          p.description ?? null,
          p.note ?? null,
          p.owner_name ?? null,
          p.owner_username ?? null,
          p.source || 'instagram',
          p.provenance,
          p.created_at,
          p.updated_at
        );
        for (const tagId of p.tag_ids || []) {
          insertPostTag.run(p.id, tagId, now);
        }
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `Restore failed: ${err.message}`);
    }

    return { body: { restored: true, collections: collectionsIn.length, tags: tagsIn.length, posts: postsIn.length } };
  }

  return { download, restore };
}

module.exports = { createBackupApi, SCHEMA_VERSION };
