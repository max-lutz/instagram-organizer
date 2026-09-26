// JSON API for Posts: CRUD, list/search/sort (issue #5), and Tag attach/detach
// with the 4-tags-per-post cap (CONTEXT.md). Route shape was this ticket's
// (issue #12) to decide.
const { HttpError } = require('./http-error');
const { parseId } = require('./params');
const { createTombstones } = require('./tombstones');

const PROVENANCE_VALUES = ['manual', 'bulk-paste', 'instagram-import'];
// CONTEXT.md: "a Post can carry up to 4 [Tags]." App-level only -- not enforced by the schema.
const MAX_TAGS_PER_POST = 4;

// node:sqlite throws a plain Error with no typed constraint-violation class,
// so we detect UNIQUE conflicts (posts.link is UNIQUE) by message.
function isUniqueViolation(err) {
  return err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

function optionalString(value, existing) {
  if (value === undefined) return existing;
  return value === null ? null : String(value);
}

// Mirrors the prototype's title-default heuristic (docs/reference/prototype/v0.1/redesign-prototype.html:350-354),
// except it returns null rather than '' for empty input, since posts.title is nullable.
function firstSentence(text) {
  if (!text) return null;
  const match = text.match(/[^.!?]*[.!?]/);
  return (match ? match[0] : text).trim();
}

// issue #5's five sort options: "saved" = created_at, "modification" = updated_at.
function sortClause(sort) {
  switch (sort) {
    case 'saved-asc':
      return 'ORDER BY p.created_at ASC';
    case 'modified-desc':
      return 'ORDER BY p.updated_at DESC';
    case 'modified-asc':
      return 'ORDER BY p.updated_at ASC';
    case 'title-asc':
      return 'ORDER BY p.title COLLATE NOCASE ASC';
    case 'saved-desc':
    default:
      return 'ORDER BY p.created_at DESC';
  }
}

function createPostsApi(db) {
  const tombstones = createTombstones(db);

  function getPostRowOr404(id) {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    if (!post) throw new HttpError(404, 'Post not found');
    return post;
  }

  function attachTags(posts) {
    if (posts.length === 0) return posts;
    const placeholders = posts.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT pt.post_id AS post_id, t.id AS id, t.name AS name, t.color AS color
         FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.post_id IN (${placeholders})
         ORDER BY t.name COLLATE NOCASE ASC`
      )
      .all(...posts.map((p) => p.id));

    const byPost = new Map();
    for (const row of rows) {
      if (!byPost.has(row.post_id)) byPost.set(row.post_id, []);
      byPost.get(row.post_id).push({ id: row.id, name: row.name, color: row.color });
    }
    return posts.map((p) => ({ ...p, tags: byPost.get(p.id) || [] }));
  }

  function getPostOr404(id) {
    return attachTags([getPostRowOr404(id)])[0];
  }

  function requireCollectionExists(id) {
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(id);
    if (!collection) throw new HttpError(400, 'Collection not found');
  }

  // collection_id / unassigned drive the sidebar's per-Collection and "To sort"
  // views; the old main-list Collection dropdown filter itself was dropped (issue #5).
  function list({ query }) {
    let sql = 'SELECT p.* FROM posts p WHERE 1 = 1';
    const args = [];

    if (query.has('collection_id')) {
      sql += ' AND p.collection_id = ?';
      args.push(parseId(query.get('collection_id'), 'collection_id'));
    } else if (query.get('unassigned') === 'true') {
      sql += ' AND p.collection_id IS NULL';
    }

    // issue #5: search covers Post Title + Description + Post Note only --
    // no Tags, no Collection name/note (that's the dedicated Collection view's job).
    const search = (query.get('search') || '').trim();
    if (search !== '') {
      sql += ' AND (LOWER(p.title) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(p.note) LIKE ?)';
      const needle = `%${search.toLowerCase()}%`;
      args.push(needle, needle, needle);
    }

    sql += ` ${sortClause(query.get('sort'))}`;

    const rows = db.prepare(sql).all(...args);
    return { body: attachTags(rows) };
  }

  function stats() {
    const total = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c;
    const unassigned = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE collection_id IS NULL').get().c;
    return { body: { total, unassigned } };
  }

  function create({ body }) {
    const link = requireString(body.link, 'link');
    const provenance = requireString(body.provenance, 'provenance');
    if (!PROVENANCE_VALUES.includes(provenance)) {
      throw new HttpError(400, `provenance must be one of: ${PROVENANCE_VALUES.join(', ')}`);
    }

    let collectionId = null;
    if (body.collection_id !== undefined && body.collection_id !== null) {
      collectionId = parseId(body.collection_id, 'collection_id');
      requireCollectionExists(collectionId);
    }

    const description = optionalString(body.description, null);
    const note = optionalString(body.note, null);
    const ownerName = optionalString(body.owner_name, null);
    const ownerUsername = optionalString(body.owner_username, null);
    const source = body.source !== undefined ? requireString(body.source, 'source') : 'instagram';

    // ADR 0003: an explicit title on create means the caller hand-picked it,
    // so it's persisted as manual from the start rather than left to auto-derive.
    const titleManual = body.title !== undefined;
    const title = titleManual ? String(body.title) : firstSentence(description);

    const now = Date.now();
    let id;
    try {
      const result = db
        .prepare(
          `INSERT INTO posts
            (link, collection_id, title, title_manual, description, note, owner_name, owner_username, source, provenance, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          link,
          collectionId,
          title,
          titleManual ? 1 : 0,
          description,
          note,
          ownerName,
          ownerUsername,
          source,
          provenance,
          now,
          now
        );
      id = result.lastInsertRowid;
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A post with that link already exists');
      throw err;
    }

    // #30's invariant: a tombstone only exists for a link that isn't
    // currently live, so a manual re-add clears any prior tombstone for it.
    tombstones.clearTombstone(link);

    return { status: 201, body: getPostOr404(id) };
  }

  function get({ params }) {
    return { body: getPostOr404(parseId(params.id)) };
  }

  // issue #3's amended resolution: link is immutable after creation
  // (app-level only -- the schema itself has no update guard).
  function update({ params, body }) {
    if (body.link !== undefined) throw new HttpError(400, 'link is immutable after creation');

    const existing = getPostRowOr404(parseId(params.id));

    let collectionId = existing.collection_id;
    if (body.collection_id !== undefined) {
      if (body.collection_id === null) {
        collectionId = null;
      } else {
        collectionId = parseId(body.collection_id, 'collection_id');
        requireCollectionExists(collectionId);
      }
    }

    const description = optionalString(body.description, existing.description);
    const note = optionalString(body.note, existing.note);
    const ownerName = optionalString(body.owner_name, existing.owner_name);
    const ownerUsername = optionalString(body.owner_username, existing.owner_username);

    // ADR 0003: Title defaults to Description's first sentence and keeps
    // auto-following it -- until the user hand-edits Title, at which point
    // title_manual latches on and further Description edits stop touching it.
    let title = existing.title;
    let titleManual = existing.title_manual;
    if (body.title !== undefined) {
      title = String(body.title);
      titleManual = 1;
    } else if (body.description !== undefined && !existing.title_manual) {
      title = firstSentence(description);
    }

    const now = Date.now();
    db.prepare(
      `UPDATE posts SET
        collection_id = ?, title = ?, title_manual = ?, description = ?, note = ?,
        owner_name = ?, owner_username = ?, updated_at = ?
       WHERE id = ?`
    ).run(collectionId, title, titleManual, description, note, ownerName, ownerUsername, now, existing.id);

    return { body: getPostOr404(existing.id) };
  }

  function remove({ params }) {
    const existing = getPostRowOr404(parseId(params.id));
    tombstones.tombstonePosts([existing]);
    db.prepare('DELETE FROM posts WHERE id = ?').run(existing.id);
    return { body: { deleted: true } };
  }

  function attachTag({ params, body }) {
    const postId = parseId(params.id);
    getPostRowOr404(postId);
    const tagId = parseId(body.tag_id, 'tag_id');
    const tag = db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
    if (!tag) throw new HttpError(404, 'Tag not found');

    // Idempotent: re-attaching a tag the post already has is a no-op rather
    // than a conflict, and doesn't count against the cap below.
    const alreadyAttached = db
      .prepare('SELECT 1 FROM post_tags WHERE post_id = ? AND tag_id = ?')
      .get(postId, tagId);

    if (!alreadyAttached) {
      const count = db.prepare('SELECT COUNT(*) AS c FROM post_tags WHERE post_id = ?').get(postId).c;
      if (count >= MAX_TAGS_PER_POST) {
        throw new HttpError(422, `A post can have at most ${MAX_TAGS_PER_POST} tags`);
      }
      db.prepare('INSERT INTO post_tags (post_id, tag_id, created_at) VALUES (?, ?, ?)').run(
        postId,
        tagId,
        Date.now()
      );
    }

    return { body: getPostOr404(postId) };
  }

  function detachTag({ params }) {
    const postId = parseId(params.id);
    getPostRowOr404(postId);
    const tagId = parseId(params.tagId, 'tagId');
    db.prepare('DELETE FROM post_tags WHERE post_id = ? AND tag_id = ?').run(postId, tagId);
    return { body: getPostOr404(postId) };
  }

  return { list, stats, create, get, update, remove, attachTag, detachTag };
}

module.exports = { createPostsApi };
