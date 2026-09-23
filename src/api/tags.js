// JSON API for Tags: CRUD only. Attaching/detaching a Tag to/from a Post is
// posts.js's job (it owns the post_tags join and the 4-tags-per-post cap).
const { HttpError } = require('./http-error');
const { parseId } = require('./params');

// node:sqlite throws a plain Error with no typed constraint-violation class,
// so we detect UNIQUE conflicts (tags.name is UNIQUE COLLATE NOCASE) by message.
function isUniqueViolation(err) {
  return err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

function createTagsApi(db) {
  function getTagOr404(id) {
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
    if (!tag) throw new HttpError(404, 'Tag not found');
    return tag;
  }

  function list() {
    return { body: db.prepare('SELECT * FROM tags ORDER BY name COLLATE NOCASE ASC').all() };
  }

  function create({ body }) {
    const name = requireString(body.name, 'name');
    const color = requireString(body.color, 'color');
    const now = Date.now();

    let id;
    try {
      const result = db
        .prepare('INSERT INTO tags (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(name, color, now, now);
      id = result.lastInsertRowid;
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A tag with that name already exists');
      throw err;
    }

    return { status: 201, body: getTagOr404(id) };
  }

  function update({ params, body }) {
    const existing = getTagOr404(parseId(params.id));
    const name = body.name !== undefined ? requireString(body.name, 'name') : existing.name;
    const color = body.color !== undefined ? requireString(body.color, 'color') : existing.color;
    const now = Date.now();

    try {
      db.prepare('UPDATE tags SET name = ?, color = ?, updated_at = ? WHERE id = ?').run(
        name,
        color,
        now,
        existing.id
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A tag with that name already exists');
      throw err;
    }

    return { body: getTagOr404(existing.id) };
  }

  // issue #3: tag deletion cascades to post_tags via the FK. Confirming with
  // the user first is a frontend concern -- this endpoint just does the delete.
  function remove({ params }) {
    const existing = getTagOr404(parseId(params.id));
    db.prepare('DELETE FROM tags WHERE id = ?').run(existing.id);
    return { body: { deleted: true } };
  }

  return { list, create, update, remove };
}

module.exports = { createTagsApi };
