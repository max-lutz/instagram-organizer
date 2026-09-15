const { HttpError } = require('./http-error');

function parseId(raw, field = 'id') {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return id;
}

module.exports = { parseId };
