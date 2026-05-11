/**
 * Public routes - participant-facing API (v2)
 * Users log in with admin-created credentials. No demographics.
 * Recordings can have audio, text, or both. At least one is required.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf-8'));
}
function writeJson(filename, data) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}
function generateId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}
function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

// POST /api/login - user login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const users = readJson('users.json').users;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});

// POST /api/logout
router.post('/logout', (req, res) => {
  if (req.session) req.session.destroy(() => res.json({ ok: true }));
  else res.json({ ok: true });
});

// GET /api/me - check current session
router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ authenticated: true, user: { id: req.session.userId, username: req.session.username } });
  }
  res.json({ authenticated: false });
});

// GET /api/datasets - list of visible datasets (requires login)
router.get('/datasets', requireUser, (req, res) => {
  const index = readJson('datasets-index.json');
  const visible = index.datasets.filter(d => d.visible);
  res.json({ datasets: visible.map(d => ({
    id: d.id,
    title: d.title,
    description: d.description,
    source_language: d.source_language,
    target_language: d.target_language,
    sentence_count: d.sentence_count,
    created_at: d.created_at
  })) });
});

// GET /api/datasets/:id - full dataset (requires login)
router.get('/datasets/:id', requireUser, (req, res) => {
  const index = readJson('datasets-index.json');
  const meta = index.datasets.find(d => d.id === req.params.id && d.visible);
  if (!meta) return res.status(404).json({ error: 'Dataset not found or hidden' });

  const filePath = path.join(DATA_DIR, 'datasets', `${meta.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Dataset file missing' });
  }
  const dataset = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  res.json(dataset);
});

// POST /api/recordings - upload audio and/or text translation
router.post('/recordings', requireUser, upload.single('audio'), (req, res) => {
  try {
    const userId = req.session.userId;
    const username = req.session.username;
    const {
      dataset_id, sentence_id, source_text, hierarchy_path,
      paragraph_id, duration_seconds, text_translation
    } = req.body;

    if (!dataset_id || !sentence_id) {
      return res.status(400).json({ error: 'Missing dataset_id or sentence_id' });
    }

    const hasAudio = !!req.file;
    const hasText = typeof text_translation === 'string' && text_translation.trim().length > 0;
    if (!hasAudio && !hasText) {
      return res.status(400).json({ error: 'Provide at least an audio recording or a text translation' });
    }

    const recordings = readJson('recordings.json');
    const existingIdx = recordings.recordings.findIndex(r =>
      r.user_id === userId &&
      r.dataset_id === dataset_id &&
      r.sentence_id === sentence_id
    );

    let relativeAudioPath = null;
    if (hasAudio) {
      const dir = path.join(UPLOADS_DIR, userId, dataset_id);
      fs.mkdirSync(dir, { recursive: true });
      const audioFilePath = path.join(dir, `${sentence_id}.webm`);
      fs.writeFileSync(audioFilePath, req.file.buffer);
      relativeAudioPath = path.relative(
        path.join(__dirname, '..'),
        audioFilePath
      ).split(path.sep).join('/');
    } else if (existingIdx >= 0) {
      relativeAudioPath = recordings.recordings[existingIdx].audio_path || null;
    }

    const existing = existingIdx >= 0 ? recordings.recordings[existingIdx] : null;

    const recording = {
      id: existing ? existing.id : generateId('rec'),
      user_id: userId,
      username,
      dataset_id,
      sentence_id,
      source_text: source_text || '',
      hierarchy_path: hierarchy_path ? safeJsonParse(hierarchy_path, []) : [],
      paragraph_id: paragraph_id || null,
      audio_path: relativeAudioPath,
      text_translation: hasText ? text_translation.trim() : (existing ? existing.text_translation : ''),
      duration_seconds: duration_seconds ? parseFloat(duration_seconds) : (existing ? existing.duration_seconds : null),
      transcription: existing ? existing.transcription : '',
      transcription_status: existing ? existing.transcription_status : 'pending',
      transcription_updated_at: existing ? existing.transcription_updated_at : null,
      recorded_at: new Date().toISOString()
    };

    if (existingIdx >= 0) {
      recordings.recordings[existingIdx] = recording;
    } else {
      recordings.recordings.push(recording);
    }
    writeJson('recordings.json', recordings);

    res.json({ id: recording.id, ok: true });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
