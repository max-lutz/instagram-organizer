// JSON API for Sections: CRUD only. A Section is a lightweight grouping
// above Collection (decision on issue #28) -- name only, no note/color.
const { HttpError } = require('./http-error');
const { parseId } = require('./params');

// node:sqlite throws a plain Error with no typed constraint-violation class,
// so we detect UNIQUE conflicts (sections.name is UNIQUE COLLATE NOCASE) by message.
function isUniqueViolation(err) {
  return err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

function createSectionsApi(db) {
  function getSectionOr404(id) {
    const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
    if (!section) throw new HttpError(404, 'Section not found');
    return section;
  }

  function list() {
    return { body: db.prepare('SELECT * FROM sections ORDER BY name COLLATE NOCASE ASC').all() };
  }

  function create({ body }) {
    const name = requireString(body.name, 'name');
    const now = Date.now();

    let id;
    try {
      const result = db
        .prepare('INSERT INTO sections (name, created_at, updated_at) VALUES (?, ?, ?)')
        .run(name, now, now);
      id = result.lastInsertRowid;
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A section with that name already exists');
      throw err;
    }

    return { status: 201, body: getSectionOr404(id) };
  }

  function update({ params, body }) {
    const existing = getSectionOr404(parseId(params.id));
    const name = requireString(body.name, 'name');
    const now = Date.now();

    try {
      db.prepare('UPDATE sections SET name = ?, updated_at = ? WHERE id = ?').run(name, now, existing.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A section with that name already exists');
      throw err;
    }

    return { body: getSectionOr404(existing.id) };
  }

  // Decision on #28: deleting a Section never touches or prompts about its
  // Collections -- the FK's ON DELETE SET NULL unassigns them back to
  // ungrouped, since a Section holds no content of its own to lose.
  function remove({ params }) {
    const existing = getSectionOr404(parseId(params.id));
    db.prepare('DELETE FROM sections WHERE id = ?').run(existing.id);
    return { body: { deleted: true } };
  }

  return { list, create, update, remove };
}

module.exports = { createSectionsApi };
