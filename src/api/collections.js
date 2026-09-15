const { HttpError } = require('./http-error');
const { parseId } = require('./params');

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
  function getCollectionRowOr404(id) {
    const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
    if (!collection) throw new HttpError(404, 'Collection not found');
    return collection;
  }

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
    const now = Date.now();

    let id;
    try {
      const result = db
        .prepare(
          'INSERT INTO collections (name, note, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(name, note, color, now, now);
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
    const now = Date.now();

    try {
      db.prepare('UPDATE collections SET name = ?, note = ?, color = ?, updated_at = ? WHERE id = ?').run(
        name,
        note,
        color,
        now,
        existing.id
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A collection with that name already exists');
      throw err;
    }

    return { body: getCollectionOr404(existing.id) };
  }

  function remove({ params, query }) {
    const existing = getCollectionRowOr404(parseId(params.id));
    const deletePosts = query.get('deletePosts') === 'true';

    let postsDeleted = 0;
    db.exec('BEGIN');
    try {
      if (deletePosts) {
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
