/**
 * Public routes - participant-facing API (v2 - MySQL)
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { pool } = require('../db');

const router     = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 50 * 1024 * 1024 },
});

function generateId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

// WebM magic bytes: 1A 45 DF A3
function isWebm(buffer) {
  return buffer.length >= 4 &&
    buffer[0] === 0x1A && buffer[1] === 0x45 &&
    buffer[2] === 0xDF && buffer[3] === 0xA3;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// POST /api/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  try {
    const [[user]] = await pool.execute(
      'SELECT * FROM users WHERE username = ?', [username]
    );
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId   = user.id;
    req.session.username = user.username;
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/logout
router.post('/logout', (req, res) => {
  if (req.session) req.session.destroy(() => res.json({ ok: true }));
  else res.json({ ok: true });
});

// GET /api/me
router.get('/me', (req, res) => {
  if (req.session && req.session.userId)
    return res.json({ authenticated: true, user: { id: req.session.userId, username: req.session.username } });
  res.json({ authenticated: false });
});

// ---------------------------------------------------------------------------
// Datasets  (access-controlled)
// ---------------------------------------------------------------------------

// GET /api/datasets
router.get('/datasets', requireUser, async (req, res) => {
  try {
    const userId = req.session.userId;

    // A dataset is accessible if:
    //   (a) it is visible AND has zero rows in user_dataset_access, OR
    //   (b) it is visible AND this user has an explicit row
    const [rows] = await pool.execute(
      `SELECT d.*
       FROM datasets d
       WHERE d.visible = 1
         AND (
           NOT EXISTS (SELECT 1 FROM user_dataset_access WHERE dataset_id = d.id)
           OR EXISTS  (SELECT 1 FROM user_dataset_access WHERE dataset_id = d.id AND user_id = ?)
         )
       ORDER BY d.created_at DESC`,
      [userId]
    );

    res.json({ datasets: rows.map(d => ({
      id             : d.id,
      title          : d.title,
      description    : d.description,
      source_language: d.source_language,
      target_language: d.target_language,
      sentence_count : d.sentence_count,
      created_at     : d.created_at,
    })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load datasets' });
  }
});

// GET /api/datasets/:id  — full dataset with sentences (for recorder)
router.get('/datasets/:id', requireUser, async (req, res) => {
  try {
    const userId    = req.session.userId;
    const datasetId = req.params.id;

    const [[dataset]] = await pool.execute(
      `SELECT d.*
       FROM datasets d
       WHERE d.id = ? AND d.visible = 1
         AND (
           NOT EXISTS (SELECT 1 FROM user_dataset_access WHERE dataset_id = d.id)
           OR EXISTS  (SELECT 1 FROM user_dataset_access WHERE dataset_id = d.id AND user_id = ?)
         )`,
      [datasetId, userId]
    );

    if (!dataset) return res.status(404).json({ error: 'Dataset not found or not accessible' });

    const [sentences] = await pool.execute(
      `SELECT id, text, gloss, paragraph_id, sentence_index_in_paragraph, path_json
       FROM sentences WHERE dataset_id = ?
       ORDER BY sentence_index_in_paragraph ASC, id ASC`,
      [datasetId]
    );

    res.json({
      id      : dataset.id,
      project : {
        title          : dataset.title,
        description    : dataset.description,
        source_language: dataset.source_language,
        target_language: dataset.target_language,
      },
      sentences: sentences.map(s => ({
        id                         : s.id,
        text                       : s.text,
        gloss                      : s.gloss || '',
        paragraph_id               : s.paragraph_id,
        sentence_index_in_paragraph: s.sentence_index_in_paragraph,
        path                       : JSON.parse(s.path_json || '[]'),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load dataset' });
  }
});

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

// GET /api/recordings/progress?dataset_id=xxx  — sentence IDs already recorded by this user
router.get('/recordings/progress', requireUser, async (req, res) => {
  const { dataset_id } = req.query;
  if (!dataset_id) return res.status(400).json({ error: 'dataset_id required' });
  try {
    const [rows] = await pool.execute(
      'SELECT sentence_id FROM recordings WHERE user_id = ? AND dataset_id = ?',
      [req.session.userId, dataset_id]
    );
    res.json({ recorded: rows.map(r => r.sentence_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recordings
router.post('/recordings', requireUser, upload.single('audio'), async (req, res) => {
  try {
    const userId   = req.session.userId;
    const username = req.session.username;
    const { dataset_id, sentence_id, source_text, hierarchy_path, paragraph_id, duration_seconds, text_translation } = req.body;

    if (!dataset_id || !sentence_id)
      return res.status(400).json({ error: 'Missing dataset_id or sentence_id' });

    const hasAudio = !!req.file;
    const hasText  = typeof text_translation === 'string' && text_translation.trim().length > 0;

    if (!hasAudio && !hasText)
      return res.status(400).json({ error: 'Provide at least an audio recording or a text translation' });

    // Audio validation
    if (hasAudio) {
      if (!isWebm(req.file.buffer))
        return res.status(400).json({ error: 'Invalid audio format. Only WebM audio is accepted.' });
      if (req.file.size < 1000)
        return res.status(400).json({ error: 'Audio recording is too short.' });
    }

    // Check existing recording for this user+sentence
    const [[existing]] = await pool.execute(
      'SELECT * FROM recordings WHERE user_id = ? AND dataset_id = ? AND sentence_id = ?',
      [userId, dataset_id, sentence_id]
    );

    let audioPath = existing ? existing.audio_path : null;

    if (hasAudio) {
      const dir          = path.join(UPLOADS_DIR, userId, dataset_id);
      fs.mkdirSync(dir, { recursive: true });
      const audioFilePath = path.join(dir, `${sentence_id}.webm`);
      fs.writeFileSync(audioFilePath, req.file.buffer);
      audioPath = path.relative(path.join(__dirname, '..'), audioFilePath).split(path.sep).join('/');
    }

    if (existing) {
      await pool.execute(
        `UPDATE recordings SET
           audio_path = ?, text_translation = ?, duration_seconds = ?, recorded_at = NOW()
         WHERE id = ?`,
        [audioPath,
         hasText ? text_translation.trim() : existing.text_translation,
         duration_seconds ? parseFloat(duration_seconds) : existing.duration_seconds,
         existing.id]
      );
      return res.json({ id: existing.id, ok: true });
    }

    const id = generateId('rec');
    await pool.execute(
      `INSERT INTO recordings
         (id, user_id, username, dataset_id, sentence_id, source_text,
          hierarchy_path, paragraph_id, audio_path, text_translation,
          duration_seconds, transcription, transcription_status, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'pending', NOW())`,
      [id, userId, username, dataset_id, sentence_id, source_text || '',
       hierarchy_path || '[]', paragraph_id || null,
       audioPath, hasText ? text_translation.trim() : null,
       duration_seconds ? parseFloat(duration_seconds) : null]
    );

    res.json({ id, ok: true });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
