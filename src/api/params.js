const { HttpError } = require('./http-error');

// Validates a route/query param as a positive integer id (all of this
// schema's primary keys are surrogate AUTOINCREMENT ids -- ADR 0002),
// rejecting non-numeric input with a 400 instead of letting a raw string
// reach SQLite.
function parseId(raw, field = 'id') {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return id;
}

module.exports = { parseId };
