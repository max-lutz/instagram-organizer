// JSON API for deletion tombstones (issue #30/#40): read-only snapshots plus
// the one mutable field the reimport diff workflow needs (issue #31/#41).
// Every other column is a point-in-time snapshot from the original delete
// (src/api/tombstones.js) and isn't editable here.
const { HttpError } = require('./http-error');
const { parseId } = require('./params');

function createDeletedPostsApi(db) {
  function getRowOr404(id) {
    const row = db.prepare('SELECT * FROM deleted_posts WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Deleted post not found');
    return row;
  }

  // ?dismissed=false is the reimport diff's shape: only tombstones still
  // eligible to prompt (#31: a dismissed one is "treated as if it weren't in
  // the export at all").
  function list({ query }) {
    let sql = 'SELECT * FROM deleted_posts WHERE 1 = 1';
    if (query.get('dismissed') === 'false') sql += ' AND dismissed = 0';
    else if (query.get('dismissed') === 'true') sql += ' AND dismissed = 1';
    sql += ' ORDER BY id';
    return { body: db.prepare(sql).all() };
  }

  function update({ params, body }) {
    const existing = getRowOr404(parseId(params.id));
    if (body.dismissed === undefined) throw new HttpError(400, 'dismissed is required');
    db.prepare('UPDATE deleted_posts SET dismissed = ? WHERE id = ?').run(body.dismissed ? 1 : 0, existing.id);
    return { body: getRowOr404(existing.id) };
  }

  return { list, update };
}

module.exports = { createDeletedPostsApi };
