// JSON API for Collections: CRUD plus the keep-or-delete-posts choice on
// deletion (ADR 0001). Route shape was this ticket's (issue #12) to decide.
const { HttpError } = require('./http-error');
const { parseId } = require('./params');
const { createTombstones } = require('./tombstones');

// node:sqlite throws a plain Error with no typed constraint-violation class,
// so we detect UNIQUE conflicts (collection name is UNIQUE COLLATE NOCASE) by message.
function isUniqueViolation(err) {
  return err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

function createCollectionsApi(db) {
  const tombstones = createTombstones(db);

  // Bare row, no post_count join -- used internally where callers only need
  // the collection's own columns (e.g. as defaults when applying a PATCH).
  function getCollectionRowOr404(id) {
    const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
    if (!collection) throw new HttpError(404, 'Collection not found');
    return collection;
  }

  function requireSectionExists(id) {
    const section = db.prepare('SELECT id FROM sections WHERE id = ?').get(id);
    if (!section) throw new HttpError(400, 'Section not found');
  }

  // Shared by create/update: undefined means "leave unchanged" (update only),
  // null clears it, anything else must be an existing Section's id.
  function resolveSectionId(value, existing) {
    if (value === undefined) return existing;
    if (value === null) return null;
    const id = parseId(value, 'section_id');
    requireSectionExists(id);
    return id;
  }

  // Response-shaped variant: includes post_count so clients (e.g. the
  // sidebar) don't need a second request per collection just for a badge.
  function getCollectionOr404(id) {
    const collection = db
      .prepare(
        `SELECT c.*, COUNT(p.id) AS post_count
         FROM collections c
         LEFT JOIN posts p ON p.collection_id = c.id
         WHERE c.id = ?
         GROUP BY c.id`
      )
      .get(id);
    if (!collection) throw new HttpError(404, 'Collection not found');
    return collection;
  }

  function list() {
    const rows = db
      .prepare(
        `SELECT c.*, COUNT(p.id) AS post_count
         FROM collections c
         LEFT JOIN posts p ON p.collection_id = c.id
         GROUP BY c.id
         ORDER BY c.name COLLATE NOCASE ASC`
      )
      .all();
    return { body: rows };
  }

  function create({ body }) {
    const name = requireString(body.name, 'name');
    const color = requireString(body.color, 'color');
    const note = typeof body.note === 'string' ? body.note : null;
    const sectionId = resolveSectionId(body.section_id, null);
    const now = Date.now();

    let id;
    try {
      const result = db
        .prepare(
          'INSERT INTO collections (name, note, color, section_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(name, note, color, sectionId, now, now);
      id = result.lastInsertRowid;
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A collection with that name already exists');
      throw err;
    }

    return { status: 201, body: getCollectionOr404(id) };
  }

  function get({ params }) {
    return { body: getCollectionOr404(parseId(params.id)) };
  }

  function update({ params, body }) {
    const existing = getCollectionRowOr404(parseId(params.id));
    const name = body.name !== undefined ? requireString(body.name, 'name') : existing.name;
    const color = body.color !== undefined ? requireString(body.color, 'color') : existing.color;
    const note = body.note !== undefined ? (body.note === null ? null : String(body.note)) : existing.note;
    const sectionId = resolveSectionId(body.section_id, existing.section_id);
    const now = Date.now();

    try {
      db.prepare('UPDATE collections SET name = ?, note = ?, color = ?, section_id = ?, updated_at = ? WHERE id = ?').run(
        name,
        note,
        color,
        sectionId,
        now,
        existing.id
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A collection with that name already exists');
      throw err;
    }

    return { body: getCollectionOr404(existing.id) };
  }

  // ADR 0001: deleting a Collection asks the user to keep or delete its
  // Posts. `deletePosts=true` deletes the Posts first, then the Collection,
  // inside one transaction. Without it, the FK's ON DELETE SET NULL returns
  // the Posts to "To sort" as the DB-level default/safety net.
  function remove({ params, query }) {
    const existing = getCollectionRowOr404(parseId(params.id));
    const deletePosts = query.get('deletePosts') === 'true';

    let postsDeleted = 0;
    db.exec('BEGIN');
    try {
      if (deletePosts) {
        const posts = db.prepare('SELECT * FROM posts WHERE collection_id = ?').all(existing.id);
        tombstones.tombstonePosts(posts);
        postsDeleted = db.prepare('DELETE FROM posts WHERE collection_id = ?').run(existing.id).changes;
      }
      db.prepare('DELETE FROM collections WHERE id = ?').run(existing.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return { body: { deleted: true, postsDeleted } };
  }

  return { list, create, get, update, remove };
}

module.exports = { createCollectionsApi };
