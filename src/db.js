const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'socials-organizer.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function openDb(dbPath = DB_PATH) {
  if (dbPath === DB_PATH) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

module.exports = { openDb, DB_PATH };
