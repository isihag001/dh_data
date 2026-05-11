/**
 * Admin routes - password-protected management API (v2)
 * - User management (create/list/delete generic logins)
 * - Dataset upload + template download
 * - Recording browsing, transcription, export with text_translation
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const ROOT_DIR = path.join(__dirname, '..');

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf-8'));
}
function writeJson(filename, data) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}
function generateId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function checkAdminPassword(plaintext) {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  const fallback = process.env.ADMIN_PASSWORD || 'admin';
  if (hash) return bcrypt.compareSync(plaintext, hash);
  return plaintext === fallback;
}

// POST /api/admin/login
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!checkAdminPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
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

// ===== USERS (generic logins) =====

// GET /api/admin/users - list all users with recording counts
router.get('/users', (req, res) => {
  const users = readJson('users.json').users;
  const recordings = readJson('recordings.json').recordings;
  const enriched = users.map(u => {
    const { password_hash, ...safe } = u;
    return {
      ...safe,
      recording_count: recordings.filter(r => r.user_id === u.id).length
    };
  });
  enriched.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ users: enriched });
});

// POST /api/admin/users - create a new user
router.post('/users', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 2-40 chars: letters, digits, _ . -' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  const usersFile = readJson('users.json');
  if (usersFile.users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  const user = {
    id: generateId('u'),
    username,
    password_hash: bcrypt.hashSync(password, 10),
    created_at: new Date().toISOString()
  };
  usersFile.users.push(user);
  writeJson('users.json', usersFile);
  const { password_hash, ...safe } = user;
  res.json({ ok: true, user: safe });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
  const usersFile = readJson('users.json');
  const idx = usersFile.users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'User not found' });
  usersFile.users.splice(idx, 1);
  writeJson('users.json', usersFile);
  res.json({ ok: true });
});

// PATCH /api/admin/users/:id - reset password
router.patch('/users/:id', (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  const usersFile = readJson('users.json');
  const user = usersFile.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.password_hash = bcrypt.hashSync(password, 10);
  writeJson('users.json', usersFile);
  res.json({ ok: true });
});

// ===== DATASETS =====

const datasetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

router.get('/datasets', (req, res) => {
  const index = readJson('datasets-index.json');
  res.json({ datasets: index.datasets });
});

router.post('/datasets', datasetUpload.single('dataset'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const content = req.file.buffer.toString('utf-8');
    let dataset;
    try {
      dataset = JSON.parse(content);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON: ' + e.message });
    }
    if (!dataset.project || !dataset.project.title) {
      return res.status(400).json({ error: 'Dataset must have project.title' });
    }
    if (!Array.isArray(dataset.sentences) || dataset.sentences.length === 0) {
      return res.status(400).json({ error: 'Dataset must have a non-empty sentences array' });
    }
    for (let i = 0; i < dataset.sentences.length; i++) {
      const s = dataset.sentences[i];
      if (!s.id || !s.text) {
        return res.status(400).json({ error: `Sentence at index ${i} missing id or text` });
      }
    }

    const baseId = dataset.project.title
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 40) || 'dataset';

    const index = readJson('datasets-index.json');
    let id = baseId;
    let counter = 1;
    while (index.datasets.find(d => d.id === id)) {
      id = `${baseId}-${counter++}`;
    }

    const finalDataset = { id, ...dataset };
    fs.writeFileSync(
      path.join(DATA_DIR, 'datasets', `${id}.json`),
      JSON.stringify(finalDataset, null, 2)
    );

    const meta = {
      id,
      title: dataset.project.title,
      description: dataset.project.description || '',
      source_language: dataset.project.source_language || 'Hindi',
      target_language: dataset.project.target_language || 'Marwari',
      sentence_count: dataset.sentences.length,
      visible: true,
      created_at: new Date().toISOString()
    };
    index.datasets.push(meta);
    writeJson('datasets-index.json', index);

    res.json({ ok: true, dataset: meta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/datasets/:id', (req, res) => {
  const index = readJson('datasets-index.json');
  const meta = index.datasets.find(d => d.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'Dataset not found' });
  if (typeof req.body.visible === 'boolean') meta.visible = req.body.visible;
  if (req.body.title) meta.title = req.body.title;
  if (typeof req.body.description === 'string') meta.description = req.body.description;
  writeJson('datasets-index.json', index);
  res.json({ ok: true, dataset: meta });
});

router.delete('/datasets/:id', (req, res) => {
  const index = readJson('datasets-index.json');
  const idx = index.datasets.findIndex(d => d.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Dataset not found' });
  const filePath = path.join(DATA_DIR, 'datasets', `${req.params.id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  index.datasets.splice(idx, 1);
  writeJson('datasets-index.json', index);
  res.json({ ok: true });
});

// GET /api/admin/dataset-template.zip - downloadable template bundle for AI-assisted PDF conversion
router.get('/dataset-template.zip', (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="dataset-template.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { throw err; });
  archive.pipe(res);

  // 1. dataset-template.json with inline comments via _comment fields
  const template = {
    _comment_top: "INSTRUCTIONS: This is the schema for a Marwari Audio Recorder dataset. Fill in the 'project' block and replace the 'sentences' array with your own data. Remove all '_comment*' fields before uploading.",
    project: {
      _comment: "Required: project metadata",
      title: "Your Project Title (e.g., 'Premchand - Godan, Part 1')",
      description: "Short description shown to participants",
      source_language: "Hindi",
      target_language: "Marwari",
      created_at: "2026-05-04",
      source: "Optional: where this text came from (e.g., book name, PDF filename)"
    },
    _comment_sentences: "Each sentence is one row. sentence_index_in_paragraph and paragraph_id group sentences into paragraphs so the recorder can show paragraph context. path is a 1-8 element array describing the hierarchy.",
    sentences: [
      {
        id: "s001",
        text: "होरी ने दोनों बैलों को सानी-पानी देकर अपनी स्त्री धनिया से कहा।",
        gloss: "Optional English meaning",
        path: ["Book Title", "Chapter 1", "Section 1.1"],
        paragraph_id: "p001",
        sentence_index_in_paragraph: 1
      },
      {
        id: "s002",
        text: "गोबर को भेज दे, गाय को नाँद में बाँध आये।",
        gloss: "Send Gobar to tie the cow at the trough.",
        path: ["Book Title", "Chapter 1", "Section 1.1"],
        paragraph_id: "p001",
        sentence_index_in_paragraph: 2
      }
    ]
  };
  archive.append(JSON.stringify(template, null, 2), { name: 'dataset-template.json' });

  // 2. PROMPT_FOR_AI.md
  const prompt = `# How to convert a PDF into a Marwari Audio Recorder dataset

You have three files in this folder:

- \`dataset-template.json\` - the schema, with inline \`_comment\` fields explaining what each field does
- \`example-dataset.json\` - a real working example built from museum descriptions
- \`PROMPT_FOR_AI.md\` - this file

## How to use

Open any capable AI assistant (Claude, ChatGPT, Gemini) and upload:

1. Your source PDF
2. \`dataset-template.json\`
3. \`example-dataset.json\`

Then paste this prompt:

---

I am building a parallel audio corpus for Digital Humanities research. I need you to convert the attached PDF into a JSON dataset matching the schema in \`dataset-template.json\`. A real working example is \`example-dataset.json\`. Follow these rules strictly:

### Output format

- Output a SINGLE valid JSON object.
- Do NOT include any \`_comment\` fields in the output.
- Do NOT wrap the output in markdown code fences. Output the raw JSON only.

### Project block

- \`project.title\`: derive from the PDF's title page or filename.
- \`project.description\`: a short 1-line summary.
- \`project.source_language\`: usually "Hindi".
- \`project.target_language\`: "Marwari".
- \`project.created_at\`: today's date in YYYY-MM-DD format.
- \`project.source\`: the PDF filename or book citation.

### Sentences

- The PDF contains prose. Split it into individual sentences using the Devanagari danda \`।\` as the primary terminator. Also split on \`?\` and \`!\`.
- Each sentence becomes one entry in the \`sentences\` array.
- Assign sequential IDs: \`s001\`, \`s002\`, etc.
- Group sentences into paragraphs:
  - All sentences from the same source paragraph share the same \`paragraph_id\` (e.g. \`p001\`).
  - \`sentence_index_in_paragraph\` starts at 1 within each paragraph.
- **Bullet points rule**: if the PDF has bullet points (lists), absorb them into the paragraph that immediately precedes them by giving them the same \`paragraph_id\`.
- \`path\`: an array of 1 to 8 strings representing the hierarchy from broadest to narrowest. Common levels: Book Title, Part, Chapter, Section, Subsection. Use what's actually present in the PDF, don't invent levels.
- \`gloss\`: optional English meaning. Include it ONLY if the PDF provides an English translation alongside the Hindi. Otherwise omit the field.

### Quality rules

- Preserve the original Hindi text exactly, including punctuation. Do not paraphrase or "clean up" the text.
- Do not split clauses joined by commas. Only split at sentence terminators (\`।\`, \`?\`, \`!\`).
- Skip page numbers, headers, footers, and any non-content text.
- If the PDF includes other languages (English captions, etc.), skip them. Hindi sentences only.

### Verify before responding

- Count: every sentence has \`id\`, \`text\`, \`path\`, \`paragraph_id\`, and \`sentence_index_in_paragraph\`.
- IDs are unique and sequential.
- Paragraph IDs are reused only within a single paragraph and unique across the dataset.
- Output is valid JSON (no trailing commas, no comments).

---

After the AI returns the JSON, save it as \`my-dataset.json\` and upload it via the admin dashboard's "Upload JSON" button.

## Tips

- For long PDFs, you may need to feed chunks (e.g. one chapter at a time) and merge the JSON outputs.
- Always spot-check the first 10-20 sentences before recording sessions.
- If the AI invents hierarchy levels not in the PDF, paste this back to it: "Use only the hierarchy levels actually marked in the PDF. Do not invent intermediate levels."
`;
  archive.append(prompt, { name: 'PROMPT_FOR_AI.md' });

  // 3. example-dataset.json - load the sample dataset if it exists
  const sampleFile = path.join(ROOT_DIR, 'sample-dataset.json');
  if (fs.existsSync(sampleFile)) {
    archive.file(sampleFile, { name: 'example-dataset.json' });
  } else {
    // Fallback minimal example
    const example = {
      project: {
        title: "Sample Project",
        description: "Example",
        source_language: "Hindi",
        target_language: "Marwari",
        created_at: "2026-05-04"
      },
      sentences: [
        { id: "s001", text: "नमस्ते दुनिया।", path: ["Sample"], paragraph_id: "p001", sentence_index_in_paragraph: 1 }
      ]
    };
    archive.append(JSON.stringify(example, null, 2), { name: 'example-dataset.json' });
  }

  archive.finalize();
});

// ===== RECORDINGS =====

router.get('/recordings', (req, res) => {
  const recordings = readJson('recordings.json').recordings;
  let filtered = recordings;
  if (req.query.dataset_id) {
    filtered = filtered.filter(r => r.dataset_id === req.query.dataset_id);
  }
  if (req.query.user_id) {
    filtered = filtered.filter(r => r.user_id === req.query.user_id);
  }
  if (req.query.transcription_status) {
    filtered = filtered.filter(r => r.transcription_status === req.query.transcription_status);
  }
  if (req.query.has_audio === 'true') filtered = filtered.filter(r => !!r.audio_path);
  if (req.query.has_audio === 'false') filtered = filtered.filter(r => !r.audio_path);

  filtered.sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
  res.json({ recordings: filtered });
});

router.get('/recordings/:id/audio', (req, res) => {
  const recordings = readJson('recordings.json').recordings;
  const rec = recordings.find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found' });
  if (!rec.audio_path) return res.status(404).json({ error: 'No audio for this recording' });
  const fullPath = path.join(ROOT_DIR, rec.audio_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Audio file missing' });
  res.setHeader('Content-Type', 'audio/webm');
  fs.createReadStream(fullPath).pipe(res);
});

router.patch('/recordings/:id/transcription', (req, res) => {
  const { transcription, transcription_status } = req.body || {};
  const recordings = readJson('recordings.json');
  const rec = recordings.recordings.find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found' });
  if (typeof transcription === 'string') rec.transcription = transcription;
  if (transcription_status && ['pending', 'done', 'needs_review'].includes(transcription_status)) {
    rec.transcription_status = transcription_status;
  }
  rec.transcription_updated_at = new Date().toISOString();
  writeJson('recordings.json', recordings);
  res.json({ ok: true, recording: rec });
});

router.delete('/recordings/:id', (req, res) => {
  const recordings = readJson('recordings.json');
  const idx = recordings.recordings.findIndex(r => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Recording not found' });
  const rec = recordings.recordings[idx];
  if (rec.audio_path) {
    const fullPath = path.join(ROOT_DIR, rec.audio_path);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
  recordings.recordings.splice(idx, 1);
  writeJson('recordings.json', recordings);
  res.json({ ok: true });
});

// GET /api/admin/datasets/:id/export.zip - parallel corpus export
router.get('/datasets/:id/export.zip', (req, res) => {
  const datasetId = req.params.id;
  const indexFile = readJson('datasets-index.json');
  const datasetMeta = indexFile.datasets.find(d => d.id === datasetId);
  if (!datasetMeta) return res.status(404).json({ error: 'Dataset not found' });

  const datasetFile = path.join(DATA_DIR, 'datasets', `${datasetId}.json`);
  const dataset = JSON.parse(fs.readFileSync(datasetFile, 'utf-8'));

  const allRecordings = readJson('recordings.json').recordings.filter(r => r.dataset_id === datasetId);

  const parallelCorpus = allRecordings.map(rec => {
    const sentence = dataset.sentences.find(s => s.id === rec.sentence_id) || {};
    const audioFilename = rec.audio_path ? `${rec.user_id}_${rec.sentence_id}.webm` : null;
    return {
      audio_file: audioFilename ? `audio/${audioFilename}` : null,
      source_text: sentence.text || rec.source_text,
      source_gloss: sentence.gloss || '',
      source_language: dataset.project?.source_language || 'Hindi',
      user_text_translation: rec.text_translation || '',
      admin_transcription: rec.transcription || '',
      target_language: dataset.project?.target_language || 'Marwari',
      transcription_status: rec.transcription_status,
      duration_seconds: rec.duration_seconds,
      hierarchy_path: rec.hierarchy_path || sentence.path || [],
      paragraph_id: rec.paragraph_id || sentence.paragraph_id || null,
      sentence_id: rec.sentence_id,
      recording_id: rec.id,
      username: rec.username,
      user_id: rec.user_id,
      recorded_at: rec.recorded_at
    };
  });

  const csvHeaders = [
    'audio_file', 'source_text', 'user_text_translation', 'admin_transcription', 'transcription_status',
    'source_language', 'target_language', 'duration_seconds',
    'sentence_id', 'paragraph_id', 'hierarchy_path',
    'username', 'user_id', 'recorded_at'
  ];
  const escapeCsv = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const csvRows = [csvHeaders.join(',')];
  parallelCorpus.forEach(row => {
    csvRows.push([
      escapeCsv(row.audio_file),
      escapeCsv(row.source_text),
      escapeCsv(row.user_text_translation),
      escapeCsv(row.admin_transcription),
      escapeCsv(row.transcription_status),
      escapeCsv(row.source_language),
      escapeCsv(row.target_language),
      escapeCsv(row.duration_seconds),
      escapeCsv(row.sentence_id),
      escapeCsv(row.paragraph_id),
      escapeCsv((row.hierarchy_path || []).join(' > ')),
      escapeCsv(row.username),
      escapeCsv(row.user_id),
      escapeCsv(row.recorded_at)
    ].join(','));
  });

  const manifest = {
    dataset: datasetMeta,
    project: dataset.project,
    total_sentences_in_dataset: dataset.sentences.length,
    total_recordings: allRecordings.length,
    recordings_with_audio: allRecordings.filter(r => !!r.audio_path).length,
    recordings_with_text: allRecordings.filter(r => !!r.text_translation).length,
    transcription_summary: {
      pending: allRecordings.filter(r => r.transcription_status === 'pending').length,
      done: allRecordings.filter(r => r.transcription_status === 'done').length,
      needs_review: allRecordings.filter(r => r.transcription_status === 'needs_review').length
    },
    contributors: [...new Set(allRecordings.map(r => r.username))],
    exported_at: new Date().toISOString()
  };

  const dateStr = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${datasetId}_export_${dateStr}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { throw err; });
  archive.pipe(res);

  archive.append(JSON.stringify(parallelCorpus, null, 2), { name: 'parallel_corpus.json' });
  archive.append('\ufeff' + csvRows.join('\n'), { name: 'parallel_corpus.csv' });
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  archive.append(JSON.stringify(dataset, null, 2), { name: 'original_dataset.json' });

  allRecordings.forEach(rec => {
    if (!rec.audio_path) return;
    const fullPath = path.join(ROOT_DIR, rec.audio_path);
    if (fs.existsSync(fullPath)) {
      const audioFilename = `${rec.user_id}_${rec.sentence_id}.webm`;
      archive.file(fullPath, { name: `audio/${audioFilename}` });
    }
  });

  archive.finalize();
});

module.exports = router;
