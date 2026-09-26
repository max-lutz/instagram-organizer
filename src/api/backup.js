// JSON API for backup/restore (issue #3's settled format, issue #15). A flat,
// normalized mirror of the DB tables -- ids preserved so collection_id/tag_ids
// resolve on restore. Restore is a full wipe-and-replace, kept a separate code
// path from the additive Instagram-export import flow (map #10 Notes).
const { HttpError } = require('./http-error');
const { createTombstones } = require('./tombstones');

// Bumped from 5 to 6 to add posts.reimport_dismissed and
// deleted_posts.dismissed (issue #41), which would otherwise be lost on a
// restore.
const SCHEMA_VERSION = 6;

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array`);
  return value;
}

function createBackupApi(db) {
  const tombstones = createTombstones(db);

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
      reimport_dismissed: p.reimport_dismissed,
      created_at: p.created_at,
      updated_at: p.updated_at,
      tag_ids: tagIdsByPost.get(p.id) || [],
    }));
  }

  function backupDeletedPosts() {
    return db
      .prepare(
        `SELECT link, title, description, note, owner_name, owner_username, collection_name, tags, deleted_at, dismissed
         FROM deleted_posts ORDER BY id`
      )
      .all();
  }

  function download() {
    const sections = db.prepare('SELECT id, name, created_at, updated_at FROM sections ORDER BY id').all();
    const collections = db
      .prepare('SELECT id, name, note, color, section_id, created_at, updated_at FROM collections ORDER BY id')
      .all();
    const tags = db.prepare('SELECT id, name, color, created_at, updated_at FROM tags ORDER BY id').all();
    return {
      body: {
        schema_version: SCHEMA_VERSION,
        sections,
        collections,
        tags,
        posts: backupPosts(),
        deleted_posts: backupDeletedPosts(),
      },
    };
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
    const sectionsIn = requireArray(body.sections ?? [], 'sections');
    const collectionsIn = requireArray(body.collections, 'collections');
    const tagsIn = requireArray(body.tags ?? [], 'tags');
    const postsIn = requireArray(body.posts, 'posts');
    const deletedPostsIn = requireArray(body.deleted_posts ?? [], 'deleted_posts');

    // issue #40: this restore's wipe is a hard delete of whatever Posts are
    // currently live, same as the other hard-delete call sites -- except a
    // link the incoming backup also restores isn't actually gone, so only
    // truly-discarded links get tombstoned. Snapshotting must happen before
    // the wipe below (it reads pre-restore Collections/Tags), but writing the
    // rows happens after deleted_posts itself is restored, so these take
    // precedence over the backup's own tombstones for any overlapping link.
    const incomingLinks = new Set(postsIn.map((p) => p.link));
    const discardedPosts = db
      .prepare('SELECT * FROM posts')
      .all()
      .filter((p) => !incomingLinks.has(p.link));
    const discardedTombstoneRows = tombstones.buildTombstoneRows(discardedPosts);

    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM post_tags');
      db.exec('DELETE FROM posts');
      db.exec('DELETE FROM tags');
      db.exec('DELETE FROM collections');
      db.exec('DELETE FROM sections');
      db.exec('DELETE FROM deleted_posts');

      // Sections first -- collections.section_id references them, and foreign
      // keys are enforced (db.js: PRAGMA foreign_keys = ON).
      const insertSection = db.prepare(
        'INSERT INTO sections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)'
      );
      for (const s of sectionsIn) {
        insertSection.run(s.id, s.name, s.created_at, s.updated_at);
      }

      const insertCollection = db.prepare(
        'INSERT INTO collections (id, name, note, color, section_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const c of collectionsIn) {
        insertCollection.run(c.id, c.name, c.note ?? null, c.color, c.section_id ?? null, c.created_at, c.updated_at);
      }

      const insertTag = db.prepare(
        'INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      );
      for (const t of tagsIn) {
        insertTag.run(t.id, t.name, t.color, t.created_at, t.updated_at);
      }

      const insertPost = db.prepare(
        `INSERT INTO posts
          (id, link, collection_id, title, title_manual, description, note, owner_name, owner_username, source, provenance, reimport_dismissed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          p.reimport_dismissed ? 1 : 0,
          p.created_at,
          p.updated_at
        );
        for (const tagId of p.tag_ids || []) {
          insertPostTag.run(p.id, tagId, now);
        }
      }

      const insertDeletedPost = db.prepare(
        `INSERT INTO deleted_posts
          (link, title, description, note, owner_name, owner_username, collection_name, tags, deleted_at, dismissed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const d of deletedPostsIn) {
        insertDeletedPost.run(
          d.link,
          d.title ?? null,
          d.description ?? null,
          d.note ?? null,
          d.owner_name ?? null,
          d.owner_username ?? null,
          d.collection_name ?? null,
          d.tags ?? '[]',
          d.deleted_at,
          d.dismissed ? 1 : 0
        );
      }
      tombstones.insertTombstoneRows(discardedTombstoneRows);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `Restore failed: ${err.message}`);
    }

    // deleted_posts isn't a straight wipe-and-replace count -- this restore's
    // own discarded-Post tombstones (discardedTombstoneRows) land on top of
    // the backup's deletedPostsIn, so the actual row count can exceed either.
    const deletedPostsCount = db.prepare('SELECT COUNT(*) AS c FROM deleted_posts').get().c;

    return {
      body: {
        restored: true,
        sections: sectionsIn.length,
        collections: collectionsIn.length,
        tags: tagsIn.length,
        posts: postsIn.length,
        deleted_posts: deletedPostsCount,
      },
    };
  }

  return { download, restore };
}

module.exports = { createBackupApi, SCHEMA_VERSION };
