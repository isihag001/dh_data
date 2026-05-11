# Marwari Audio Recorder (v2)

A self-hosted Node.js web app for crowdsourcing Hindi to Marwari translations, built for Digital Humanities research. Participants log in with admin-issued credentials and contribute by recording audio, typing text, or both. Recordings include the full hierarchical context (Project > Chapter > Section etc.) and paragraph context for each sentence. An admin dashboard handles dataset uploads, user management, transcription, and parallel-corpus export.

## What's new in v2

- **User accounts instead of demographic forms.** Admin creates generic logins (e.g. `translator01` / password) and shares them with participants. No personal info is collected.
- **Text translation field alongside audio.** Each sentence can have an audio recording, a typed Marwari translation, or both. Sentences left empty are skipped silently.
- **Dataset template download.** A "Download template" button in the admin dashboard provides a ZIP with the schema, an example dataset, and a ready-to-paste prompt for converting PDFs to JSON using any AI assistant.

## Features

- **Participant flow**: Log in with username/password, pick a dataset, record audio and/or type Marwari translations sentence by sentence with full paragraph context.
- **Automatic server-side upload** as participants record. No manual file transfer.
- **Admin dashboard** (separate password-protected `/admin` page) with four tabs:
  - **Datasets**: Upload JSON, toggle visibility, download as parallel corpus ZIP, download empty template
  - **Users**: Create / delete / reset password for participant logins
  - **Recordings**: Browse, filter (dataset/status/audio-or-text), listen, delete
  - **Transcribe**: Dedicated workspace with playback speed control and a Devanagari textarea for manual transcription of audio recordings
- **Parallel corpus export** as a ZIP with audio + JSON + CSV + manifest, directly usable for AI model training

## Tech stack

- Node.js (>= 18), Express, express-session, multer, archiver, bcryptjs
- Plain HTML, CSS, vanilla JS (no build step)
- File-based JSON storage (no database)

## Local setup

```bash
npm install
cp .env.example .env
# Edit .env to set ADMIN_PASSWORD and SESSION_SECRET
npm start
# Open http://localhost:3000
```

Then:
1. Go to `http://localhost:3000/admin`, sign in with your admin password
2. Go to the **Users** tab, create a participant login (e.g. `tester` / `test1234`)
3. Go to the **Datasets** tab, upload a JSON file (or use the included `sample-dataset.json`)
4. Open `http://localhost:3000/` in a separate browser, log in as the test user, pick the dataset, and try recording

## Hostinger deployment

This app is built for Hostinger's Business Web Hosting (or higher) with Node.js support enabled.

1. **Upload files** via File Manager, FTP, or SFTP. Exclude `node_modules/`, `.env`, and `uploads/`.
2. **Create Node.js app** in hPanel > Advanced > Node.js. Set:
   - Node version: 18.x or higher
   - Application root: where you uploaded the folder
   - Application startup file: `server.js`
   - Click **Run npm install**
3. **Set environment variables** in the Node.js panel:
   - `SESSION_SECRET` = a long random string
   - `ADMIN_PASSWORD` = your admin password (or `ADMIN_PASSWORD_HASH` for the bcrypt-hashed version)
4. **Restart** the app and visit your application URL.

## Folder structure

```
marwari-recorder/
├── server.js                  # Express entry point
├── package.json
├── .env.example
├── README.md
│
├── routes/
│   ├── public.js              # Participant-facing API (login, datasets, recordings)
│   └── admin.js               # Admin API (users, datasets, recordings, transcription)
│
├── data/
│   ├── datasets/              # Uploaded dataset JSONs
│   ├── datasets-index.json    # Visibility/metadata for each dataset
│   ├── users.json             # Generic login credentials (hashed)
│   └── recordings.json        # Recording metadata + transcriptions
│
├── uploads/                   # Audio files
│   └── {user_id}/
│       └── {dataset_id}/
│           └── {sentence_id}.webm
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
      "path": ["Book Title", "Chapter 1", "Section 1.1"],
      "paragraph_id": "p001",
      "sentence_index_in_paragraph": 1
    }
  ]
}
```

- `path`: 1 to 8 strings representing the hierarchy
- `paragraph_id`: sentences sharing this ID are shown as paragraph context with the current target highlighted
- `gloss`: optional English meaning hint
- For prose with bullet points, give the bullets the same `paragraph_id` as the paragraph preceding them

## Template-based PDF to JSON conversion

The admin Datasets tab has a "Download template" button. It gives you a ZIP containing:

- `dataset-template.json` - the schema with explanatory comments
- `example-dataset.json` - a real working example
- `PROMPT_FOR_AI.md` - a ready-to-paste prompt

Upload all three files to any capable AI assistant along with your source PDF, paste the prompt, and you get back a valid JSON dataset ready to upload via the admin's "Upload JSON" button.

## Parallel corpus export

Clicking "Download ZIP" for any dataset gives you:

```
dataset_export_YYYY-MM-DD/
├── audio/                     # All audio files, named {user_id}_{sentence_id}.webm
├── parallel_corpus.json       # Source text + user text + admin transcription + audio path + metadata
├── parallel_corpus.csv        # Same as flat CSV
├── manifest.json              # Dataset info, contributors, transcription summary
└── original_dataset.json      # The dataset as originally uploaded
```

The `parallel_corpus.json` is directly usable for AI training:

```json
[
  {
    "audio_file": "audio/u_xyz_s001.webm",
    "source_text": "मैं बाज़ार जा रहा हूँ।",
    "source_language": "Hindi",
    "user_text_translation": "हूं हाट जाऊं हूं।",
    "admin_transcription": "हूं हाट जाऊं हूं।",
    "target_language": "Marwari",
    "transcription_status": "done",
    "duration_seconds": 4.2,
    "username": "translator01",
    "hierarchy_path": ["Book", "Chapter 1"],
    "paragraph_id": "p001"
  }
]
```

Note that `user_text_translation` is what the participant typed themselves, while `admin_transcription` is what you typed in the Transcribe tab after listening to the audio. Both fields can be empty.

## API summary

### Public (user session required)
- `POST /api/login` - participant login
- `POST /api/logout`
- `GET /api/me` - current session info
- `GET /api/datasets` - list visible datasets
- `GET /api/datasets/:id` - get full dataset
- `POST /api/recordings` - upload audio and/or text (multipart)

### Admin (admin password required)
- `POST /api/admin/login` / `logout` / `auth-status`
- `GET/POST/PATCH/DELETE /api/admin/users` - manage user accounts
- `GET/POST/PATCH/DELETE /api/admin/datasets`
- `GET /api/admin/dataset-template.zip` - download the template bundle
- `GET /api/admin/datasets/:id/export.zip` - download parallel corpus
- `GET /api/admin/recordings` - list with filters
- `GET /api/admin/recordings/:id/audio` - stream audio
- `PATCH /api/admin/recordings/:id/transcription` - update transcription
- `DELETE /api/admin/recordings/:id`

## Backup recommendation

Important folders to back up regularly:
- `data/` (datasets, users, recordings metadata)
- `uploads/` (audio files)
