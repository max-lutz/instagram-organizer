const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'socials-organizer.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// schema.sql only ever CREATEs tables/columns that don't exist yet, so a
// column added to an existing table (like collections.section_id, issue #27)
// needs an explicit ALTER for databases created before that column existed.
// Runs after schema.sql so `sections` (the new column's FK target) already
// exists, and before the index below, which needs the column to be there.
function migrateCollectionsSectionId(db) {
  const columns = db.prepare('PRAGMA table_info(collections)').all();
  const hasSectionId = columns.some((c) => c.name === 'section_id');
  if (!hasSectionId) {
    db.exec('ALTER TABLE collections ADD COLUMN section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL');
  }
}

function openDb(dbPath = DB_PATH) {
  if (dbPath === DB_PATH) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrateCollectionsSectionId(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_collections_section_id ON collections(section_id)');
  return db;
}

module.exports = { openDb, DB_PATH };
