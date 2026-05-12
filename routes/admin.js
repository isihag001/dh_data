/**
 * Admin routes - password-protected management API (v2 - MySQL)
 */

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const archiver   = require('archiver');
const bcrypt     = require('bcryptjs');
const crypto     = require('crypto');
const { pool }   = require('../db');

const router      = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const ROOT_DIR    = path.join(__dirname, '..');

function generateId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  console.warn('[auth] Not authenticated — session id:', req.sessionID, 'isAdmin:', req.session && req.session.isAdmin);
  return res.status(401).json({ error: 'Not authenticated' });
}

function checkAdminPassword(plaintext) {
  const hash     = process.env.ADMIN_PASSWORD_HASH;
  const fallback = process.env.ADMIN_PASSWORD || 'admin';
  if (hash) return bcrypt.compareSync(plaintext, hash);
  return plaintext === fallback;
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!checkAdminPassword(password)) return res.status(401).json({ error: 'Invalid password' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/auth-status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

// All routes below require admin auth
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------------
router.get('/users', async (req, res) => {
  try {
    const [users] = await pool.execute(
      `SELECT u.id, u.username, u.created_at,
              COUNT(r.id) AS recording_count
       FROM users u
       LEFT JOIN recordings r ON r.user_id = u.id
       GROUP BY u.id, u.username, u.created_at
       ORDER BY u.created_at DESC`
    );
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(username))
    return res.status(400).json({ error: 'Username must be 2-40 chars: letters, digits, _ . -' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters' });

  try {
    const id   = generateId('u');
    const hash = bcrypt.hashSync(password, 10);
    await pool.execute(
      'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)',
      [id, username, hash]
    );
    res.json({ ok: true, user: { id, username } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id  — reset password
router.patch('/users/:id', async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  try {
    const hash          = bcrypt.hashSync(password, 10);
    const [result]      = await pool.execute(
      'UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id  — cascades recordings + user_dataset_access
router.delete('/users/:id', async (req, res) => {
  try {
    // Delete audio files for this user's recordings
    const [recs] = await pool.execute(
      'SELECT audio_path FROM recordings WHERE user_id = ? AND audio_path IS NOT NULL',
      [req.params.id]
    );
    for (const r of recs) {
      const fp = path.join(ROOT_DIR, r.audio_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    const [result] = await pool.execute('DELETE FROM users WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DATASETS
// ---------------------------------------------------------------------------
router.get('/datasets', async (req, res) => {
  try {
    const [datasets] = await pool.execute(
      'SELECT * FROM datasets ORDER BY created_at DESC'
    );

    // Attach list of restricted user IDs per dataset
    for (const d of datasets) {
      const [access] = await pool.execute(
        'SELECT user_id FROM user_dataset_access WHERE dataset_id = ?', [d.id]
      );
      d.restricted_to = access.map(a => a.user_id);
    }

    res.json({ datasets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const datasetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/datasets', datasetUpload.single('dataset'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let dataset;
    try {
      dataset = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON: ' + e.message });
    }

    if (!dataset.project || !dataset.project.title)
      return res.status(400).json({ error: 'Dataset must have project.title' });
    if (!Array.isArray(dataset.sentences) || dataset.sentences.length === 0)
      return res.status(400).json({ error: 'Dataset must have a non-empty sentences array' });
    for (let i = 0; i < dataset.sentences.length; i++) {
      if (!dataset.sentences[i].id || !dataset.sentences[i].text)
        return res.status(400).json({ error: `Sentence at index ${i} missing id or text` });
    }

    // Build a unique ID
    let baseId = dataset.project.title.toLowerCase()
      .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').substring(0, 40) || 'dataset';
    let id = baseId; let counter = 1;
    while (true) {
      const [[{ n }]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM datasets WHERE id = ?', [id]
      );
      if (!parseInt(n)) break;
      id = `${baseId}-${counter++}`;
    }

    await pool.execute(
      `INSERT INTO datasets (id, title, description, source_language, target_language, visible, sentence_count)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [id, dataset.project.title, dataset.project.description || '',
       dataset.project.source_language || 'Hindi', dataset.project.target_language || 'Marwari',
       dataset.sentences.length]
    );

    for (const s of dataset.sentences) {
      await pool.execute(
        `INSERT INTO sentences (id, dataset_id, text, gloss, paragraph_id, sentence_index_in_paragraph, path_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [s.id, id, s.text, s.gloss || null, s.paragraph_id || null,
         s.sentence_index_in_paragraph || null, JSON.stringify(s.path || [])]
      );
    }

    const [[meta]] = await pool.execute('SELECT * FROM datasets WHERE id = ?', [id]);
    res.json({ ok: true, dataset: meta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/datasets/:id', async (req, res) => {
  try {
    const fields = []; const vals = [];
    if (typeof req.body.visible === 'boolean') { fields.push('visible = ?'); vals.push(req.body.visible ? 1 : 0); }
    if (req.body.title)                         { fields.push('title = ?');   vals.push(req.body.title); }
    if (typeof req.body.description === 'string') { fields.push('description = ?'); vals.push(req.body.description); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(req.params.id);
    const [result] = await pool.execute(`UPDATE datasets SET ${fields.join(', ')} WHERE id = ?`, vals);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Dataset not found' });
    const [[meta]] = await pool.execute('SELECT * FROM datasets WHERE id = ?', [req.params.id]);
    res.json({ ok: true, dataset: meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/datasets/:id  — cascades sentences, recordings, access rows + audio files
router.delete('/datasets/:id', async (req, res) => {
  try {
    const [recs] = await pool.execute(
      'SELECT audio_path FROM recordings WHERE dataset_id = ? AND audio_path IS NOT NULL',
      [req.params.id]
    );
    for (const r of recs) {
      const fp = path.join(ROOT_DIR, r.audio_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    const [result] = await pool.execute('DELETE FROM datasets WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Dataset not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DATASET ↔ USER ACCESS CONTROL
// ---------------------------------------------------------------------------

// GET /api/admin/datasets/:id/users  — all users with their access flag
router.get('/datasets/:id/users', async (req, res) => {
  try {
    const [users] = await pool.execute(
      `SELECT u.id, u.username,
              IF(a.user_id IS NOT NULL, 1, 0) AS has_access
       FROM users u
       LEFT JOIN user_dataset_access a ON a.user_id = u.id AND a.dataset_id = ?
       ORDER BY u.username ASC`,
      [req.params.id]
    );
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/datasets/:id/access  — replace entire access list
// Body: { user_ids: ["u_abc", "u_xyz"] }   empty array = open to all
router.put('/datasets/:id/access', async (req, res) => {
  const { user_ids } = req.body || {};
  if (!Array.isArray(user_ids))
    return res.status(400).json({ error: 'user_ids must be an array' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM user_dataset_access WHERE dataset_id = ?', [req.params.id]);
    for (const uid of user_ids) {
      await conn.execute(
        'INSERT IGNORE INTO user_dataset_access (user_id, dataset_id) VALUES (?, ?)',
        [uid, req.params.id]
      );
    }
    await conn.commit();
    res.json({ ok: true, restricted_to: user_ids });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------
// RECORDINGS  (paginated)
// ---------------------------------------------------------------------------
router.get('/recordings', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
    const offset = parseInt(req.query.offset || '0');

    const conds = []; const vals = [];
    if (req.query.dataset_id)           { conds.push('r.dataset_id = ?');           vals.push(req.query.dataset_id); }
    if (req.query.user_id)              { conds.push('r.user_id = ?');              vals.push(req.query.user_id); }
    if (req.query.transcription_status) { conds.push('r.transcription_status = ?'); vals.push(req.query.transcription_status); }
    if (req.query.has_audio === 'true') conds.push('r.audio_path IS NOT NULL');
    if (req.query.has_audio === 'false') conds.push('r.audio_path IS NULL');

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM recordings r ${where}`, vals
    );

    const [recordings] = await pool.execute(
      `SELECT r.* FROM recordings r ${where}
       ORDER BY r.recorded_at DESC
       LIMIT ? OFFSET ?`,
      [...vals, limit, offset]
    );

    res.json({
      recordings,
      pagination: { total: parseInt(total), limit, offset },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/recordings/:id/audio
router.get('/recordings/:id/audio', async (req, res) => {
  try {
    const [[rec]] = await pool.execute(
      'SELECT audio_path FROM recordings WHERE id = ?', [req.params.id]
    );
    if (!rec)            return res.status(404).json({ error: 'Recording not found' });
    if (!rec.audio_path) return res.status(404).json({ error: 'No audio for this recording' });
    const fullPath = path.join(ROOT_DIR, rec.audio_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Audio file missing on disk' });
    res.sendFile(fullPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/recordings/:id/transcription
router.patch('/recordings/:id/transcription', async (req, res) => {
  const { transcription, transcription_status } = req.body || {};
  const allowed = ['pending', 'done', 'needs_review'];

  try {
    const fields = ['transcription_updated_at = NOW()']; const vals = [];
    if (typeof transcription === 'string') { fields.push('transcription = ?'); vals.push(transcription); }
    if (transcription_status && allowed.includes(transcription_status)) {
      fields.push('transcription_status = ?'); vals.push(transcription_status);
    }
    vals.push(req.params.id);
    const [result] = await pool.execute(
      `UPDATE recordings SET ${fields.join(', ')} WHERE id = ?`, vals
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Recording not found' });
    const [[rec]] = await pool.execute('SELECT * FROM recordings WHERE id = ?', [req.params.id]);
    res.json({ ok: true, recording: rec });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/recordings/:id
router.delete('/recordings/:id', async (req, res) => {
  try {
    const [[rec]] = await pool.execute(
      'SELECT audio_path FROM recordings WHERE id = ?', [req.params.id]
    );
    if (!rec) return res.status(404).json({ error: 'Recording not found' });
    if (rec.audio_path) {
      const fp = path.join(ROOT_DIR, rec.audio_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await pool.execute('DELETE FROM recordings WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------

// GET /api/admin/datasets/:id/export.zip
//   Optional query params: ?user_id=u_xxx  &status=done
router.get('/datasets/:id/export.zip', async (req, res) => {
  try {
    const datasetId = req.params.id;

    const [[dataset]] = await pool.execute('SELECT * FROM datasets WHERE id = ?', [datasetId]);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    const [sentences] = await pool.execute(
      'SELECT * FROM sentences WHERE dataset_id = ?', [datasetId]
    );
    const sentenceMap = Object.fromEntries(sentences.map(s => [s.id, s]));

    // Build filter
    const conds = ['r.dataset_id = ?']; const vals = [datasetId];
    if (req.query.user_id) { conds.push('r.user_id = ?'); vals.push(req.query.user_id); }
    if (req.query.status)  { conds.push('r.transcription_status = ?'); vals.push(req.query.status); }

    const [recs] = await pool.execute(
      `SELECT r.* FROM recordings r WHERE ${conds.join(' AND ')} ORDER BY r.recorded_at ASC`, vals
    );

    const corpus = recs.map(r => {
      const s           = sentenceMap[r.sentence_id] || {};
      const audioFile   = r.audio_path ? `audio/${r.user_id}_${r.sentence_id}.webm` : null;
      return {
        audio_file            : audioFile,
        source_text           : s.text || r.source_text,
        source_gloss          : s.gloss || '',
        source_language       : dataset.source_language,
        user_text_translation : r.text_translation || '',
        admin_transcription   : r.transcription || '',
        target_language       : dataset.target_language,
        transcription_status  : r.transcription_status,
        duration_seconds      : r.duration_seconds,
        hierarchy_path        : JSON.parse(r.hierarchy_path || '[]'),
        paragraph_id          : r.paragraph_id,
        sentence_id           : r.sentence_id,
        recording_id          : r.id,
        username              : r.username,
        user_id               : r.user_id,
        recorded_at           : r.recorded_at,
      };
    });

    const csvHeaders = ['audio_file','source_text','user_text_translation','admin_transcription',
      'transcription_status','source_language','target_language','duration_seconds',
      'sentence_id','paragraph_id','hierarchy_path','username','user_id','recorded_at'];
    const esc = v => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csvRows = [csvHeaders.join(',')];
    corpus.forEach(row => csvRows.push([
      esc(row.audio_file), esc(row.source_text), esc(row.user_text_translation),
      esc(row.admin_transcription), esc(row.transcription_status),
      esc(row.source_language), esc(row.target_language), esc(row.duration_seconds),
      esc(row.sentence_id), esc(row.paragraph_id),
      esc((row.hierarchy_path || []).join(' > ')),
      esc(row.username), esc(row.user_id), esc(row.recorded_at),
    ].join(',')));

    // Per-user stats for manifest
    const userStats = {};
    recs.forEach(r => {
      if (!userStats[r.username]) userStats[r.username] = { total: 0, audio: 0, text: 0 };
      userStats[r.username].total++;
      if (r.audio_path)      userStats[r.username].audio++;
      if (r.text_translation) userStats[r.username].text++;
    });

    const manifest = {
      dataset,
      filters: { user_id: req.query.user_id || null, status: req.query.status || null },
      total_recordings: recs.length,
      recordings_with_audio: recs.filter(r => !!r.audio_path).length,
      recordings_with_text : recs.filter(r => !!r.text_translation).length,
      transcription_summary: {
        pending     : recs.filter(r => r.transcription_status === 'pending').length,
        done        : recs.filter(r => r.transcription_status === 'done').length,
        needs_review: recs.filter(r => r.transcription_status === 'needs_review').length,
      },
      per_user_stats: userStats,
      exported_at: new Date().toISOString(),
    };

    const dateStr = new Date().toISOString().split('T')[0];
    const suffix  = req.query.user_id ? `_${req.query.user_id}` : '';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${datasetId}${suffix}_${dateStr}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    archive.append(JSON.stringify(corpus,   null, 2), { name: 'parallel_corpus.json' });
    archive.append('﻿' + csvRows.join('\n'),      { name: 'parallel_corpus.csv' });
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    recs.forEach(r => {
      if (!r.audio_path) return;
      const fp = path.join(ROOT_DIR, r.audio_path);
      if (fs.existsSync(fp))
        archive.file(fp, { name: `audio/${r.user_id}_${r.sentence_id}.webm` });
    });

    archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DATASET TEMPLATE
// ---------------------------------------------------------------------------
router.get('/dataset-template.zip', async (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="dataset-template.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { throw err; });
  archive.pipe(res);

  const template = {
    _comment_top: "Remove all _comment* fields before uploading.",
    project: {
      title: "Your Project Title",
      description: "Short description",
      source_language: "Hindi",
      target_language: "Marwari",
      created_at: new Date().toISOString().split('T')[0],
    },
    sentences: [
      { id: "s001", text: "होरी ने दोनों बैलों को सानी-पानी देकर अपनी स्त्री धनिया से कहा।",
        gloss: "Optional English meaning", path: ["Book Title", "Chapter 1"],
        paragraph_id: "p001", sentence_index_in_paragraph: 1 },
      { id: "s002", text: "गोबर को भेज दे, गाय को नाँद में बाँध आये।",
        path: ["Book Title", "Chapter 1"], paragraph_id: "p001", sentence_index_in_paragraph: 2 },
    ]
  };
  archive.append(JSON.stringify(template, null, 2), { name: 'dataset-template.json' });

  const sampleFile = path.join(ROOT_DIR, 'sample-dataset.json');
  if (fs.existsSync(sampleFile))
    archive.file(sampleFile, { name: 'example-dataset.json' });

  archive.finalize();
});

module.exports = router;
