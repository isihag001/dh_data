/**
 * MySQL connection pool, schema initialisation, and one-time JSON migration.
 */

const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR = path.join(__dirname, 'data');

const pool = mysql.createPool({
  host              : process.env.MYSQL_HOST     || 'localhost',
  port              : parseInt(process.env.MYSQL_PORT || '3306'),
  user              : process.env.MYSQL_USER,
  password          : process.env.MYSQL_PASSWORD,
  database          : process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit   : 10,
  timezone          : 'Z',
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
async function initSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id           VARCHAR(32)  PRIMARY KEY,
        username     VARCHAR(40)  NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS datasets (
        id              VARCHAR(100) PRIMARY KEY,
        title           VARCHAR(255) NOT NULL,
        description     TEXT,
        source_language VARCHAR(50)  DEFAULT 'Hindi',
        target_language VARCHAR(50)  DEFAULT 'Marwari',
        visible         TINYINT(1)   DEFAULT 1,
        sentence_count  INT          DEFAULT 0,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS sentences (
        id                          VARCHAR(100) NOT NULL,
        dataset_id                  VARCHAR(100) NOT NULL,
        text                        TEXT         NOT NULL,
        gloss                       TEXT,
        paragraph_id                VARCHAR(100),
        sentence_index_in_paragraph INT,
        path_json                   TEXT,
        PRIMARY KEY (id, dataset_id),
        FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS recordings (
        id                      VARCHAR(32)  PRIMARY KEY,
        user_id                 VARCHAR(32)  NOT NULL,
        username                VARCHAR(40)  NOT NULL,
        dataset_id              VARCHAR(100),
        sentence_id             VARCHAR(100),
        source_text             TEXT,
        hierarchy_path          TEXT,
        paragraph_id            VARCHAR(100),
        audio_path              VARCHAR(500),
        text_translation        TEXT,
        duration_seconds        FLOAT,
        transcription           TEXT,
        transcription_status    ENUM('pending','done','needs_review') DEFAULT 'pending',
        transcription_updated_at DATETIME,
        recorded_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Junction table: if a dataset has ANY rows here only those users can see it.
    // Zero rows = open to all logged-in users (backwards compatible).
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_dataset_access (
        user_id    VARCHAR(32)  NOT NULL,
        dataset_id VARCHAR(100) NOT NULL,
        PRIMARY KEY (user_id, dataset_id),
        FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
        FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// One-time migration from JSON files → MySQL
// ---------------------------------------------------------------------------
async function migrate() {
  const [[{ count }]] = await pool.execute('SELECT COUNT(*) AS count FROM users');
  if (parseInt(count) > 0) return; // Already migrated

  console.log('[db] Starting one-time migration from JSON files…');

  // Users
  const usersFile = path.join(DATA_DIR, 'users.json');
  if (fs.existsSync(usersFile)) {
    const { users = [] } = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
    for (const u of users) {
      await pool.execute(
        'INSERT IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
        [u.id, u.username, u.password_hash, new Date(u.created_at)]
      );
    }
    console.log(`[db]   Migrated ${users.length} user(s).`);
  }

  // Datasets + sentences
  const indexFile = path.join(DATA_DIR, 'datasets-index.json');
  if (fs.existsSync(indexFile)) {
    const { datasets = [] } = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    for (const d of datasets) {
      await pool.execute(
        `INSERT IGNORE INTO datasets
           (id, title, description, source_language, target_language, visible, sentence_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, d.title, d.description || '', d.source_language || 'Hindi',
         d.target_language || 'Marwari', d.visible ? 1 : 0,
         d.sentence_count || 0, new Date(d.created_at)]
      );

      const dsFile = path.join(DATA_DIR, 'datasets', `${d.id}.json`);
      if (fs.existsSync(dsFile)) {
        const dataset = JSON.parse(fs.readFileSync(dsFile, 'utf-8'));
        for (const s of dataset.sentences || []) {
          await pool.execute(
            `INSERT IGNORE INTO sentences
               (id, dataset_id, text, gloss, paragraph_id, sentence_index_in_paragraph, path_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [s.id, d.id, s.text, s.gloss || null, s.paragraph_id || null,
             s.sentence_index_in_paragraph || null, JSON.stringify(s.path || [])]
          );
        }
      }
    }
    console.log(`[db]   Migrated ${datasets.length} dataset(s).`);
  }

  // Recordings
  const recFile = path.join(DATA_DIR, 'recordings.json');
  if (fs.existsSync(recFile)) {
    const { recordings = [] } = JSON.parse(fs.readFileSync(recFile, 'utf-8'));
    let migrated = 0;
    for (const r of recordings) {
      const [[{ exists }]] = await pool.execute(
        'SELECT COUNT(*) AS exists FROM users WHERE id = ?', [r.user_id]
      );
      if (!parseInt(exists)) continue;
      await pool.execute(
        `INSERT IGNORE INTO recordings
           (id, user_id, username, dataset_id, sentence_id, source_text,
            hierarchy_path, paragraph_id, audio_path, text_translation,
            duration_seconds, transcription, transcription_status,
            transcription_updated_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.user_id, r.username, r.dataset_id || null, r.sentence_id || null,
         r.source_text || '', JSON.stringify(r.hierarchy_path || []),
         r.paragraph_id || null, r.audio_path || null,
         r.text_translation || null, r.duration_seconds || null,
         r.transcription || '', r.transcription_status || 'pending',
         r.transcription_updated_at ? new Date(r.transcription_updated_at) : null,
         new Date(r.recorded_at)]
      );
      migrated++;
    }
    console.log(`[db]   Migrated ${migrated} recording(s).`);
  }

  console.log('[db] Migration complete.');
}

module.exports = { pool, initSchema, migrate };
