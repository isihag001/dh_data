# Marwari Audio Recorder

A self-hosted web app for crowdsourcing spoken and written translations of sentences from one language into another. Out of the box it is configured for Hindi → Marwari, but the source and target languages are configurable per dataset and the app works for any language pair.

Participants log in with credentials issued by the admin, then work through datasets sentence by sentence — recording audio, typing a translation, or both. The app remembers where each participant stopped and resumes from there on the next visit. An admin dashboard handles everything else: uploading datasets, managing users, restricting which users can see which datasets, browsing/filtering recordings, manually transcribing audio, and downloading the collected data as a parallel corpus.

---

## Features

### For participants
- Username/password login (no personal data collected)
- Dataset picker showing only the datasets the admin has assigned to them
- Sentence-by-sentence recording interface with paragraph context, breadcrumb path, and a Devanagari text field
- Audio + text translation can both be submitted for the same sentence, or either alone; empty sentences are skipped silently
- **Session resume** — closing and reopening the app picks up at the first unrecorded sentence
- **Back button** to revisit and overwrite a previous sentence's recording

### For admins
Four-tab dashboard at `/admin`:

| Tab | What you can do |
|---|---|
| **Datasets** | Upload a JSON dataset, toggle visibility, assign specific users, export collected data, download the dataset template |
| **Users** | Create / delete logins, reset passwords |
| **Recordings** | Browse all recordings with filters (dataset, user, transcription status, audio/text); paginated; bulk select → set status or delete |
| **Transcribe** | Click a recording, listen at variable speed, type the Marwari transcription into a Devanagari textarea |

### Data & export
- Every user's audio is stored separately: `uploads/{user_id}/{dataset_id}/{sentence_id}.webm`
- Export any dataset as a ZIP (filterable by user and transcription status) containing audio files, `parallel_corpus.json`, `parallel_corpus.csv`, and `manifest.json`
- The JSON corpus is ready for AI/ML training pipelines

---

## Tech stack

- **Runtime**: Node.js ≥ 18, Express
- **Database**: MySQL (via `mysql2/promise`)
- **Sessions**: `express-mysql-session` — sessions survive server restarts
- **Auth**: bcryptjs for passwords; `express-rate-limit` (5 attempts / 15 min) on login
- **File uploads**: multer (audio validated as WebM by magic bytes before saving)
- **Export**: archiver (ZIP streaming)
- **Frontend**: plain HTML, CSS, vanilla JS — no build step

---

## Local setup

### Prerequisites
- Node.js 18+
- A running MySQL server with an empty database created

### Steps

```bash
git clone <repo-url>
cd marwari-recorder
npm install
cp .env.example .env
```

Edit `.env`:

```env
SESSION_SECRET=a-long-random-string-here
ADMIN_PASSWORD=your-admin-password

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=your_db_user
MYSQL_PASSWORD=your_db_password
MYSQL_DATABASE=your_db_name
```

```bash
npm start
# Open http://localhost:3000
```

On first boot the app creates all tables automatically. If `data/users.json` and `data/recordings.json` exist (from a v1 install) they are migrated into MySQL on startup and never touched again.

### Try it out
1. Go to `http://localhost:3000/admin`, sign in with your admin password
2. **Users** tab → create a participant login (e.g. `tester` / `test1234`)
3. **Datasets** tab → upload `sample-dataset.json` (included in the repo)
4. Open `http://localhost:3000` in a private/incognito window, log in as the test user, and try recording

---

## Production deployment

Any host that runs Node.js 18+ and MySQL will work. The general steps are:

1. Copy the project files to the server (exclude `node_modules/`, `.env`, `uploads/`)
2. Run `npm install --omit=dev` on the server
3. Set the environment variables from `.env.example` (see table below)
4. Start the app with a process manager (e.g. PM2: `pm2 start server.js`)

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `SESSION_SECRET` | Yes | Long random string; used to sign session cookies |
| `ADMIN_PASSWORD` | Yes* | Plaintext admin password |
| `ADMIN_PASSWORD_HASH` | Yes* | bcrypt hash — use this instead of plaintext in production |
| `MYSQL_HOST` | Yes | Use `127.0.0.1` rather than `localhost` to avoid IPv6 issues |
| `MYSQL_PORT` | No | Defaults to `3306` |
| `MYSQL_USER` | Yes | |
| `MYSQL_PASSWORD` | Yes | |
| `MYSQL_DATABASE` | Yes | The database must already exist; tables are created automatically |
| `PORT` | No | Defaults to `3000` |
| `NODE_ENV` | No | Set to `production` to enable secure (HTTPS-only) session cookies |

*Provide exactly one of `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`.

To generate a bcrypt hash:
```bash
node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

### Behind a reverse proxy (nginx, Apache, Caddy…)

Add `app.set('trust proxy', 1)` is already present in `server.js`, so `X-Forwarded-*` headers are trusted automatically. Point your proxy at the Node.js port and terminate TLS there.

---

## Folder structure

```
marwari-recorder/
├── server.js                  # Express entry point, rate limiting, session config, DB boot
├── db.js                      # MySQL pool, schema creation, one-time v1 migration
├── package.json
├── .env.example
│
├── routes/
│   ├── public.js              # Participant API: login, datasets, recordings, progress
│   └── admin.js               # Admin API: users, datasets, access control, transcription, export
│
├── uploads/                   # Audio files — back this up
│   └── {user_id}/
│       └── {dataset_id}/
│           └── {sentence_id}.webm
│
├── sample-dataset.json        # A ready-to-use example dataset
│
└── public/
    ├── index.html             # Login + dataset picker
    ├── recorder.html          # Recording interface
    ├── admin.html             # Admin dashboard
    ├── css/styles.css
    └── js/
        ├── recorder.js
        └── admin.js
```

---

## Dataset JSON schema

```json
{
  "project": {
    "title": "Project Title",
    "description": "Optional description",
    "source_language": "Hindi",
    "target_language": "Marwari"
  },
  "sentences": [
    {
      "id": "s001",
      "text": "होरी ने दोनों बैलों को सानी-पानी देकर अपनी स्त्री धनिया से कहा।",
      "gloss": "Hori, having fed and watered both bullocks, said to his wife Dhaniya.",
      "path": ["Book Title", "Chapter 1"],
      "paragraph_id": "p001",
      "sentence_index_in_paragraph": 1
    },
    {
      "id": "s002",
      "text": "गोबर को भेज दे, गाय को नाँद में बाँध आये।",
      "path": ["Book Title", "Chapter 1"],
      "paragraph_id": "p001",
      "sentence_index_in_paragraph": 2
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | Yes | Unique within the dataset |
| `text` | Yes | The sentence to translate |
| `gloss` | No | English hint shown below the sentence |
| `path` | No | 1–8 strings shown as breadcrumb hierarchy |
| `paragraph_id` | No | Sentences with the same ID are displayed together as paragraph context; the current target sentence is highlighted |
| `sentence_index_in_paragraph` | No | Integer; determines sentence order within the paragraph |

Sentences are presented in order: all sentences of paragraph 1 first (in index order), then paragraph 2, and so on.

### Converting a PDF to a dataset

The **Download template** button in the Datasets tab gives you a ZIP with the schema, a working example, and a ready-to-paste AI prompt. Upload those three files to any capable AI assistant together with your source PDF, paste the prompt, and you get back a valid JSON file ready to upload.

---

## Parallel corpus export

**Admin → Datasets → Export ZIP** opens a dialog where you can filter by user and transcription status before downloading.

The ZIP contains:

```
export/
├── audio/                     # {user_id}_{sentence_id}.webm for every recording with audio
├── parallel_corpus.json       # Full structured corpus (see below)
├── parallel_corpus.csv        # Same data as flat CSV (UTF-8 BOM for Excel compatibility)
└── manifest.json              # Dataset metadata, per-user stats, transcription summary
```

Each entry in `parallel_corpus.json`:

```json
{
  "audio_file": "audio/u_abc123_s001.webm",
  "source_text": "मैं बाज़ार जा रहा हूँ।",
  "source_language": "Hindi",
  "user_text_translation": "हूं हाट जाऊं हूं।",
  "admin_transcription": "हूं हाट जाऊं हूं।",
  "target_language": "Marwari",
  "transcription_status": "done",
  "duration_seconds": 4.2,
  "username": "translator01",
  "user_id": "u_abc123",
  "sentence_id": "s001",
  "paragraph_id": "p001",
  "hierarchy_path": ["Book Title", "Chapter 1"],
  "recorded_at": "2025-05-10T08:30:00.000Z"
}
```

- `user_text_translation` — typed by the participant during recording
- `admin_transcription` — typed by the admin in the Transcribe tab after listening to the audio
- Multiple participants can record the same sentence; each gets their own row (nothing is overwritten)

---

## API reference

### Public endpoints (participant session required)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/login` | Participant login |
| `POST` | `/api/logout` | Destroy session |
| `GET` | `/api/me` | Current session info |
| `GET` | `/api/datasets` | List accessible datasets for the logged-in user |
| `GET` | `/api/datasets/:id` | Full dataset with ordered sentences |
| `POST` | `/api/recordings` | Submit audio and/or text (multipart/form-data) |
| `GET` | `/api/recordings/progress?dataset_id=` | Sentence IDs already recorded by the current user |

### Admin endpoints (admin session required)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/admin/login` | Admin login |
| `POST` | `/api/admin/logout` | Destroy admin session |
| `GET` | `/api/admin/auth-status` | Check if admin session is active |
| `GET` | `/api/admin/users` | List all users with recording counts |
| `POST` | `/api/admin/users` | Create a user |
| `PATCH` | `/api/admin/users/:id` | Reset password |
| `DELETE` | `/api/admin/users/:id` | Delete user + all their recordings and audio |
| `GET` | `/api/admin/datasets` | List all datasets (with access lists) |
| `POST` | `/api/admin/datasets` | Upload a new dataset JSON |
| `PATCH` | `/api/admin/datasets/:id` | Update visibility / title / description |
| `DELETE` | `/api/admin/datasets/:id` | Delete dataset + sentences + recordings + audio |
| `GET` | `/api/admin/datasets/:id/users` | List all users with their access flag for this dataset |
| `PUT` | `/api/admin/datasets/:id/access` | Replace access list (`{ user_ids: [] }` = open to all) |
| `GET` | `/api/admin/datasets/:id/export.zip` | Download parallel corpus (`?user_id=&status=`) |
| `GET` | `/api/admin/dataset-template.zip` | Download the dataset template bundle |
| `GET` | `/api/admin/recordings` | List recordings (`?dataset_id=&user_id=&transcription_status=&has_audio=&limit=&offset=`) |
| `PATCH` | `/api/admin/recordings` | Bulk update transcription status (`{ ids, transcription_status }`) |
| `POST` | `/api/admin/recordings/bulk-delete` | Bulk delete recordings + audio (`{ ids }`) |
| `GET` | `/api/admin/recordings/:id/audio` | Stream audio file (supports HTTP Range) |
| `PATCH` | `/api/admin/recordings/:id/transcription` | Update transcription text and status |
| `DELETE` | `/api/admin/recordings/:id` | Delete one recording + audio file |

---

## Database schema

Five tables, all created automatically on first boot:

| Table | Purpose |
|---|---|
| `users` | Participant accounts (bcrypt-hashed passwords) |
| `datasets` | Dataset metadata |
| `sentences` | Sentences belonging to each dataset |
| `recordings` | One row per (user, sentence) pair; stores audio path, text translation, admin transcription, status |
| `user_dataset_access` | Junction table; zero rows for a dataset = open to all users |
| `sessions` | Created by `express-mysql-session` for persistent login sessions |

---

## Backup

- **MySQL database** — use `mysqldump` or your host's backup tool. Contains all users, datasets, sentences, recordings metadata, and transcriptions.
- **`uploads/` folder** — contains the actual audio `.webm` files. Back this up alongside the database.

Everything else (code, `public/`, `routes/`) is in the repo and can be re-deployed from source.
