/**
 * Admin dashboard logic (v2)
 * Tabs: Datasets, Users, Recordings, Transcribe
 */

(function() {
  const $ = id => document.getElementById(id);

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ====== AUTH ======
  async function checkAuth() {
    try {
      const res = await fetch('/api/admin/auth-status');
      const data = await res.json();
      if (data.authenticated) showAdmin(); else showLogin();
    } catch (err) { showLogin(); }
  }

  function showLogin() {
    $('login-view').style.display = 'block';
    $('admin-view').style.display = 'none';
  }

  function showAdmin() {
    $('login-view').style.display = 'none';
    $('admin-view').style.display = 'block';
    loadDatasets();
    loadDatasetOptions();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('password').value;
    const errBox = $('login-error');
    errBox.style.display = 'none';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      showAdmin();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin();
  });

  // ====== TABS ======
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $('panel-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'datasets') loadDatasets();
      if (tab.dataset.tab === 'users') loadUsers();
      if (tab.dataset.tab === 'recordings') loadRecordings();
      if (tab.dataset.tab === 'transcribe') loadTranscribeList();
    });
  });

  // ====== DATASETS ======
  async function loadDatasets() {
    const list = $('datasets-list');
    list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    try {
      const res = await fetch('/api/admin/datasets');
      const data = await res.json();
      if (!data.datasets || data.datasets.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No datasets yet</div><div class="empty-state-sub">Upload a JSON file above to get started.</div></div>';
        return;
      }
      list.innerHTML = '';
      data.datasets.forEach(d => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <div class="row row-between">
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 1.05rem; font-weight: 600; margin-bottom: 0.3rem;">${escapeHtml(d.title)}</div>
              <div class="muted" style="font-size: 0.88rem;">${escapeHtml(d.description || '')}</div>
              <div class="row mt-1" style="gap: 0.4rem;">
                <span class="pill">${d.sentence_count} sentences</span>
                <span class="pill ${d.visible ? 'success' : 'warn'}">${d.visible ? 'Visible' : 'Hidden'}</span>
                <span class="pill">${escapeHtml(d.id)}</span>
              </div>
            </div>
            <div style="display: flex; gap: 0.4rem; flex-direction: column;">
              <button data-action="toggle" data-id="${escapeHtml(d.id)}" data-visible="${d.visible}">${d.visible ? 'Hide' : 'Show'}</button>
              <a href="/api/admin/datasets/${encodeURIComponent(d.id)}/export.zip" class="btn">Download ZIP</a>
              <button data-action="delete" data-id="${escapeHtml(d.id)}" class="btn-danger">Delete</button>
            </div>
          </div>
        `;
        list.appendChild(card);
      });

      list.querySelectorAll('button[data-action="toggle"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const visible = btn.dataset.visible !== 'true';
          await fetch(`/api/admin/datasets/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visible })
          });
          loadDatasets();
          loadDatasetOptions();
        });
      });
      list.querySelectorAll('button[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this dataset? Existing recordings will remain but lose their dataset link.')) return;
          await fetch(`/api/admin/datasets/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
          loadDatasets();
          loadDatasetOptions();
        });
      });
    } catch (err) {
      list.innerHTML = '<div class="alert alert-error">' + escapeHtml(err.message) + '</div>';
    }
  }

  $('upload-dataset-btn').addEventListener('click', async () => {
    const fileInput = $('dataset-file');
    const msg = $('dataset-upload-msg');
    msg.innerHTML = '';
    if (!fileInput.files[0]) {
      msg.innerHTML = '<div class="alert alert-error">Please choose a JSON file first.</div>';
      return;
    }
    const fd = new FormData();
    fd.append('dataset', fileInput.files[0]);
    msg.innerHTML = '<div class="alert alert-info"><span class="spinner"></span> Uploading…</div>';
    try {
      const res = await fetch('/api/admin/datasets', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      msg.innerHTML = `<div class="alert alert-success">Uploaded: ${escapeHtml(data.dataset.title)}</div>`;
      fileInput.value = '';
      loadDatasets();
      loadDatasetOptions();
    } catch (err) {
      msg.innerHTML = '<div class="alert alert-error">' + escapeHtml(err.message) + '</div>';
    }
  });

  async function loadDatasetOptions() {
    try {
      const res = await fetch('/api/admin/datasets');
      const data = await res.json();
      const opts = '<option value="">All datasets</option>' +
        (data.datasets || []).map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.title)}</option>`).join('');
      $('rec-filter-dataset').innerHTML = opts;
      $('tr-filter-dataset').innerHTML = opts;
    } catch (err) { /* silent */ }
  }

  // ====== USERS ======
  async function loadUsers() {
    const list = $('users-list');
    list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    try {
      const res = await fetch('/api/admin/users');
      const data = await res.json();
      if (!data.users || data.users.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No users yet</div><div class="empty-state-sub">Create one above to give participants login credentials.</div></div>';
        return;
      }
      const rows = data.users.map(u => `
        <tr>
          <td><strong>${escapeHtml(u.username)}</strong></td>
          <td>${u.recording_count}</td>
          <td style="font-family: 'DM Mono', monospace; font-size: 11px;">${new Date(u.created_at).toLocaleString()}</td>
          <td style="text-align: right;">
            <button data-action="reset" data-id="${escapeHtml(u.id)}" data-username="${escapeHtml(u.username)}">Reset password</button>
            <button data-action="delete" data-id="${escapeHtml(u.id)}" data-username="${escapeHtml(u.username)}" class="btn-danger">Delete</button>
          </td>
        </tr>
      `).join('');
      list.innerHTML = `
        <table class="data-table">
          <thead><tr><th>Username</th><th>Recordings</th><th>Created</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;

      list.querySelectorAll('button[data-action="reset"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newPw = prompt(`New password for ${btn.dataset.username}:`);
          if (!newPw) return;
          const res = await fetch(`/api/admin/users/${encodeURIComponent(btn.dataset.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: newPw })
          });
          const data = await res.json();
          if (!res.ok) { alert(data.error); return; }
          alert(`Password updated for ${btn.dataset.username}`);
        });
      });
      list.querySelectorAll('button[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Delete user ${btn.dataset.username}? Their existing recordings will be preserved.`)) return;
          await fetch(`/api/admin/users/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
          loadUsers();
        });
      });
    } catch (err) {
      list.innerHTML = '<div class="alert alert-error">' + escapeHtml(err.message) + '</div>';
    }
  }

  $('create-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('user-create-msg');
    msg.innerHTML = '';
    const username = $('new-username').value.trim();
    const password = $('new-password').value;
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Create failed');
      msg.innerHTML = `<div class="alert alert-success">Created. Share these credentials with the participant:<br /><br />
        Username: <span class="credential-pill">${escapeHtml(username)}</span> &nbsp;
        Password: <span class="credential-pill">${escapeHtml(password)}</span></div>`;
      $('new-username').value = '';
      $('new-password').value = '';
      loadUsers();
    } catch (err) {
      msg.innerHTML = '<div class="alert alert-error">' + escapeHtml(err.message) + '</div>';
    }
  });

  // ====== RECORDINGS ======
  $('rec-filter-dataset').addEventListener('change', loadRecordings);
  $('rec-filter-status').addEventListener('change', loadRecordings);
  $('rec-filter-audio').addEventListener('change', loadRecordings);

  async function loadRecordings() {
    const list = $('recordings-list');
    list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    const params = new URLSearchParams();
    if ($('rec-filter-dataset').value) params.set('dataset_id', $('rec-filter-dataset').value);
    if ($('rec-filter-status').value) params.set('transcription_status', $('rec-filter-status').value);
    if ($('rec-filter-audio').value) params.set('has_audio', $('rec-filter-audio').value);

    try {
      const res = await fetch('/api/admin/recordings?' + params);
      const data = await res.json();
      if (!data.recordings || data.recordings.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No recordings</div></div>';
        return;
      }

      const total = data.recordings.length;
      const withAudio = data.recordings.filter(r => !!r.audio_path).length;
      const withText = data.recordings.filter(r => !!r.text_translation).length;
      const stats = `
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${total}</div></div>
          <div class="stat-card"><div class="stat-label">With audio</div><div class="stat-value">${withAudio}</div></div>
          <div class="stat-card"><div class="stat-label">With text</div><div class="stat-value">${withText}</div></div>
        </div>
      `;

      const rows = data.recordings.map(r => `
        <div class="recording-row">
          <div style="min-width: 0;">
            <div class="text">${escapeHtml(r.source_text)}</div>
            ${r.text_translation ? `<div class="user-text">→ ${escapeHtml(r.text_translation)}</div>` : ''}
            <div class="meta">
              ${escapeHtml(r.username)} ·
              ${r.audio_path ? '🎵 audio' : ''} ${r.text_translation ? '📝 text' : ''} ·
              <span class="pill ${r.transcription_status === 'done' ? 'success' : (r.transcription_status === 'needs_review' ? 'warn' : '')}">${r.transcription_status}</span>
            </div>
          </div>
          ${r.audio_path ? `<audio src="/api/admin/recordings/${encodeURIComponent(r.id)}/audio" controls preload="none"></audio>` : '<div></div>'}
          <button data-action="delete-rec" data-id="${escapeHtml(r.id)}" class="btn-danger">Delete</button>
        </div>
      `).join('');

      list.innerHTML = stats + '<div class="card" style="padding: 0;">' + rows + '</div>';

      list.querySelectorAll('button[data-action="delete-rec"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this recording? This cannot be undone.')) return;
          await fetch(`/api/admin/recordings/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
          loadRecordings();
        });
      });
    } catch (err) {
      list.innerHTML = '<div class="alert alert-error">' + escapeHtml(err.message) + '</div>';
    }
  }

  // ====== TRANSCRIBE ======
  let transcribeRecordings = [];
  let activeTranscribeId = null;

  $('tr-filter-dataset').addEventListener('change', loadTranscribeList);
  $('tr-filter-status').addEventListener('change', loadTranscribeList);

  async function loadTranscribeList() {
    const list = $('transcribe-list');
    list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    const params = new URLSearchParams();
    if ($('tr-filter-dataset').value) params.set('dataset_id', $('tr-filter-dataset').value);
    if ($('tr-filter-status').value) params.set('transcription_status', $('tr-filter-status').value);
    // Only recordings with audio are transcribable
    params.set('has_audio', 'true');

    try {
      const res = await fetch('/api/admin/recordings?' + params);
      const data = await res.json();
      transcribeRecordings = data.recordings || [];

      if (transcribeRecordings.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-sub">No audio recordings match these filters.</div></div>';
        return;
      }

      list.innerHTML = transcribeRecordings.map(r => `
        <div class="transcribe-list-item ${r.id === activeTranscribeId ? 'active' : ''}" data-id="${escapeHtml(r.id)}">
          <div class="src">${escapeHtml(r.source_text)}</div>
          <div style="font-family: 'DM Mono', monospace; font-size: 10.5px; color: var(--muted);">
            ${escapeHtml(r.username)} · <span class="pill ${r.transcription_status === 'done' ? 'success' : (r.transcription_status === 'needs_review' ? 'warn' : '')}" style="font-size: 10px; padding: 1px 6px;">${r.transcription_status}</span>
          </div>
        </div>
      `).join('');

      list.querySelectorAll('.transcribe-list-item').forEach(item => {
        item.addEventListener('click', () => openTranscribe(item.dataset.id));
      });
    } catch (err) {
      list.innerHTML = '<div class="alert alert-error">' + escapeHtml(err.message) + '</div>';
    }
  }

  function openTranscribe(id) {
    activeTranscribeId = id;
    const rec = transcribeRecordings.find(r => r.id === id);
    if (!rec) return;
    document.querySelectorAll('.transcribe-list-item').forEach(item => {
      item.classList.toggle('active', item.dataset.id === id);
    });
    renderTranscribeWorkspace(rec);
  }

  function renderTranscribeWorkspace(rec) {
    const ws = $('transcribe-workspace');
    ws.innerHTML = `
      <div class="transcribe-panel">
        <div class="section-label">Source (Hindi)</div>
        <div class="transcribe-source">${escapeHtml(rec.source_text)}</div>

        ${rec.text_translation ? `
          <div class="section-label">User's text translation</div>
          <div class="user-text-preview">${escapeHtml(rec.text_translation)}</div>
        ` : ''}

        <div class="section-label">Audio</div>
        <audio id="tr-audio" src="/api/admin/recordings/${encodeURIComponent(rec.id)}/audio" controls preload="auto" style="width: 100%;"></audio>
        <div class="audio-controls">
          <span class="muted" style="font-size: 12px;">Speed:</span>
          <button class="speed-btn" data-speed="0.5">0.5×</button>
          <button class="speed-btn" data-speed="0.75">0.75×</button>
          <button class="speed-btn active" data-speed="1">1×</button>
          <button class="speed-btn" data-speed="1.25">1.25×</button>
          <button class="speed-btn" data-speed="1.5">1.5×</button>
        </div>

        <div class="section-label">Admin transcription (Marwari, Devanagari)</div>
        <textarea id="tr-text" class="transcribe-textarea" placeholder="Type the Marwari translation as you hear it…">${escapeHtml(rec.transcription || '')}</textarea>

        <div class="transcribe-controls">
          <label style="display:inline; margin-right: 0.5rem;">Status:</label>
          <select id="tr-status" style="width: auto;">
            <option value="pending"${rec.transcription_status === 'pending' ? ' selected' : ''}>Pending</option>
            <option value="done"${rec.transcription_status === 'done' ? ' selected' : ''}>Done</option>
            <option value="needs_review"${rec.transcription_status === 'needs_review' ? ' selected' : ''}>Needs review</option>
          </select>
        </div>

        <div class="row">
          <button id="tr-save-btn" class="btn-primary">Save</button>
          <button id="tr-save-next-btn" class="btn-primary">Save &amp; next pending →</button>
          <div class="spacer"></div>
          <span id="tr-save-status" class="muted" style="font-size: 0.85rem;"></span>
        </div>

        <div class="muted mt-1" style="font-size: 0.8rem;">
          Recorded by: ${escapeHtml(rec.username)}<br />
          Recorded: ${new Date(rec.recorded_at).toLocaleString()}
        </div>
      </div>
    `;

    const audio = $('tr-audio');
    ws.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        ws.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        audio.playbackRate = parseFloat(btn.dataset.speed);
      });
    });

    $('tr-save-btn').addEventListener('click', () => saveTranscription(rec.id, false));
    $('tr-save-next-btn').addEventListener('click', () => saveTranscription(rec.id, true));

    $('tr-text').focus();
  }

  async function saveTranscription(id, advanceToNext) {
    const text = $('tr-text').value;
    const status = $('tr-status').value;
    const statusLabel = $('tr-save-status');
    statusLabel.innerHTML = '<span class="spinner"></span> saving…';

    try {
      const res = await fetch(`/api/admin/recordings/${encodeURIComponent(id)}/transcription`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcription: text, transcription_status: status })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');

      const local = transcribeRecordings.find(r => r.id === id);
      if (local) {
        local.transcription = text;
        local.transcription_status = status;
      }
      statusLabel.innerHTML = '✓ saved';
      statusLabel.style.color = 'var(--success)';

      if (advanceToNext) {
        const remaining = transcribeRecordings.filter(r => r.id !== id && r.transcription_status === 'pending');
        if (remaining.length > 0) {
          openTranscribe(remaining[0].id);
        } else {
          await loadTranscribeList();
        }
      } else {
        await loadTranscribeList();
        if (transcribeRecordings.find(r => r.id === id)) openTranscribe(id);
      }
    } catch (err) {
      statusLabel.textContent = 'Save failed: ' + err.message;
      statusLabel.style.color = 'var(--warn)';
    }
  }

  checkAuth();
})();
