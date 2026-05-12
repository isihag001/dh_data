/**
 * Recorder v2
 * - Audio AND text translation, both optional
 * - If both empty when clicking Next, skip silently (no upload)
 * - Uses session-based user auth (no participant_id in URL)
 */

(function() {
  const params = new URLSearchParams(window.location.search);
  const datasetId = params.get('dataset');

  if (!datasetId) {
    window.location.href = '/';
    return;
  }

  // State
  let dataset = null;
  let sentences = [];
  let currentIdx = 0;
  let mediaRecorder = null;
  let chunks = [];
  let recording = false;
  let audioBlob = null;
  let audioUrl = null;
  let timerInterval = null;
  let seconds = 0;
  let analyser = null;
  let audioCtx = null;
  let animFrame = null;
  let recordingStartTime = null;
  let stats = { saved: 0, skipped: 0, audio_only: 0, text_only: 0, both: 0 };

  const $ = id => document.getElementById(id);
  const els = {
    error: $('error'),
    loading: $('loading'),
    ui: $('recorder-ui'),
    doneUi: $('done-ui'),
    currentUser: $('current-user'),
    title: $('dataset-title'),
    counter: $('counter'),
    progress: $('progress'),
    breadcrumb: $('breadcrumb'),
    contextLabel: $('context-label'),
    context: $('context'),
    target: $('target-sentence'),
    gloss: $('gloss'),
    recBtn: $('rec-btn'),
    wave: $('wave'),
    recStatus: $('rec-status'),
    playbackRow: $('playback-row'),
    playBtn: $('play-btn'),
    rerecordBtn: $('rerecord-btn'),
    discardAudioBtn: $('discard-audio-btn'),
    textTranslation: $('text-translation'),
    nextBtn: $('next-btn'),
    saveStatus: $('save-status'),
    summary: $('summary')
  };

  function showError(msg) {
    els.error.textContent = msg;
    els.error.style.display = 'block';
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function buildContext(sentence) {
    if (!sentence.paragraph_id) return '';
    const paraSentences = sentences.filter(s => s.paragraph_id === sentence.paragraph_id);
    if (paraSentences.length <= 1) return '';
    return paraSentences.map(s => {
      const html = escapeHtml(s.text);
      return s.id === sentence.id
        ? `<span class="target">${html}</span>`
        : html;
    }).join(' ');
  }

  function formatTime(s) {
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function renderSentence() {
    if (currentIdx >= sentences.length) {
      renderDone();
      return;
    }
    const s = sentences[currentIdx];
    els.counter.textContent = `Sentence ${currentIdx + 1} of ${sentences.length}`;
    els.progress.style.width = ((currentIdx / sentences.length) * 100) + '%';

    const path = s.path || [];
    els.breadcrumb.innerHTML = path.length > 0
      ? path.map(p => `<span>${escapeHtml(p)}</span>`).join('')
      : '<span style="color: transparent;">.</span>';

    const ctx = buildContext(s);
    els.context.innerHTML = ctx;
    els.contextLabel.style.display = ctx ? '' : 'none';
    els.context.style.display = ctx ? '' : 'none';

    els.target.textContent = s.text;
    els.gloss.textContent = s.gloss || '';
    els.gloss.style.display = s.gloss ? '' : 'none';

    // Reset both inputs
    audioBlob = null;
    audioUrl = null;
    els.playbackRow.style.display = 'none';
    els.textTranslation.value = '';
    els.saveStatus.textContent = '';
    els.saveStatus.style.color = '';
    els.recStatus.textContent = 'tap to record';
    els.recStatus.style.color = '';
    els.nextBtn.disabled = false;
    setRecBtnState(false);
    drawIdleWave();
  }

  function setRecBtnState(isRecording) {
    if (isRecording) {
      els.recBtn.classList.add('recording');
      els.recBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
      els.recBtn.title = 'Stop';
    } else {
      els.recBtn.classList.remove('recording');
      els.recBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>';
      els.recBtn.title = 'Record';
    }
  }

  function drawIdleWave() {
    const canvas = els.wave;
    const ctx = canvas.getContext('2d');
    const w = canvas.offsetWidth || 300;
    const h = canvas.offsetHeight || 48;
    canvas.width = w; canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    ctx.strokeStyle = isDark ? '#5a5040' : '#c8bfb0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();
  }

  function startWaveAnim() {
    if (animFrame) cancelAnimationFrame(animFrame);
    const canvas = els.wave;
    const ctx = canvas.getContext('2d');
    const w = canvas.offsetWidth || 300;
    const h = canvas.offsetHeight || 48;
    canvas.width = w; canvas.height = h;
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const color = isDark ? '#d4784a' : '#b85c2a';
    function draw() {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      if (analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(data);
        const step = Math.ceil(data.length / w);
        ctx.moveTo(0, h / 2);
        for (let i = 0; i < w; i++) {
          const v = data[i * step] || 128;
          ctx.lineTo(i, (v / 128) * h / 2);
        }
      }
      ctx.stroke();
      animFrame = requestAnimationFrame(draw);
    }
    draw();
  }

  async function toggleRecord() {
    if (recording) { stopRecording(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
      } catch (e) { /* analyser optional */ }

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      mediaRecorder = new MediaRecorder(stream, { mimeType });
      chunks = [];
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        audioBlob = new Blob(chunks, { type: 'audio/webm' });
        audioUrl = URL.createObjectURL(audioBlob);
        stream.getTracks().forEach(t => t.stop());
        if (audioCtx) { audioCtx.close(); audioCtx = null; analyser = null; }
        if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
        recording = false;
        clearInterval(timerInterval);
        setRecBtnState(false);
        els.recStatus.style.color = '';
        els.recStatus.textContent = 'recorded ✓';
        els.playbackRow.style.display = 'flex';
        drawIdleWave();
      };

      recordingStartTime = Date.now();
      mediaRecorder.start();
      recording = true;
      seconds = 0;
      setRecBtnState(true);
      els.recStatus.style.color = 'var(--warn)';
      els.recStatus.textContent = formatTime(0);
      timerInterval = setInterval(() => {
        seconds++;
        els.recStatus.textContent = formatTime(seconds);
      }, 1000);
      startWaveAnim();
    } catch (err) {
      alert('Microphone access is required for audio recording. You can still type a text translation instead.');
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }

  function playback() {
    if (!audioUrl) return;
    const a = new Audio(audioUrl);
    a.play();
  }

  function discardAudio() {
    audioBlob = null;
    audioUrl = null;
    els.playbackRow.style.display = 'none';
    els.recStatus.textContent = 'tap to record';
    els.recStatus.style.color = '';
  }

  function rerecord() {
    discardAudio();
    toggleRecord();
  }

  async function next() {
    const s = sentences[currentIdx];
    const text = els.textTranslation.value.trim();
    const hasAudio = !!audioBlob;
    const hasText = text.length > 0;

    if (!hasAudio && !hasText) {
      // Skip silently
      stats.skipped++;
      currentIdx++;
      renderSentence();
      return;
    }

    // Upload
    els.nextBtn.disabled = true;
    els.saveStatus.innerHTML = '<span class="spinner"></span> saving…';
    els.saveStatus.style.color = '';

    const duration = recordingStartTime && hasAudio ? (Date.now() - recordingStartTime) / 1000 : null;

    const formData = new FormData();
    formData.append('dataset_id', datasetId);
    formData.append('sentence_id', s.id);
    formData.append('source_text', s.text);
    formData.append('hierarchy_path', JSON.stringify(s.path || []));
    if (s.paragraph_id) formData.append('paragraph_id', s.paragraph_id);
    if (hasText) formData.append('text_translation', text);
    if (hasAudio) {
      if (duration) formData.append('duration_seconds', duration.toFixed(2));
      formData.append('audio', audioBlob, `${s.id}.webm`);
    }

    try {
      const res = await fetch('/api/recordings', { method: 'POST', body: formData });
      if (res.status === 401) {
        // Session expired
        alert('Your session has expired. Please sign in again.');
        window.location.href = '/';
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');

      stats.saved++;
      if (hasAudio && hasText) stats.both++;
      else if (hasAudio) stats.audio_only++;
      else stats.text_only++;

      currentIdx++;
      renderSentence();
    } catch (err) {
      els.saveStatus.textContent = 'Save failed: ' + err.message;
      els.saveStatus.style.color = 'var(--warn)';
      els.nextBtn.disabled = false;
    }
  }

  function renderDone() {
    els.ui.style.display = 'none';
    els.doneUi.style.display = 'block';
    els.summary.innerHTML = `
      <strong>Session summary</strong><br />
      Total saved: <strong>${stats.saved}</strong><br />
      &nbsp;&nbsp;Audio + text: ${stats.both}<br />
      &nbsp;&nbsp;Audio only: ${stats.audio_only}<br />
      &nbsp;&nbsp;Text only: ${stats.text_only}<br />
      Skipped: <strong>${stats.skipped}</strong><br />
      Total sentences: ${sentences.length}
    `;
  }

  async function init() {
    try {
      // First check session
      const meRes = await fetch('/api/me');
      const me = await meRes.json();
      if (!me.authenticated) {
        window.location.href = '/';
        return;
      }
      els.currentUser.textContent = me.user.username;

      const res = await fetch('/api/datasets/' + encodeURIComponent(datasetId));
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Dataset not found');
      }
      dataset = await res.json();
      sentences = dataset.sentences || [];
      if (sentences.length === 0) throw new Error('Dataset has no sentences.');

      // Resume from first unrecorded sentence
      const progRes  = await fetch('/api/recordings/progress?dataset_id=' + encodeURIComponent(datasetId));
      const progData = await progRes.json();
      const recorded = new Set(progData.recorded || []);
      const resumeIdx = sentences.findIndex(s => !recorded.has(s.id));
      currentIdx = resumeIdx === -1 ? sentences.length : resumeIdx;

      els.title.textContent = dataset.project.title;
      els.loading.style.display = 'none';
      els.ui.style.display = 'block';

      els.recBtn.addEventListener('click', toggleRecord);
      els.nextBtn.addEventListener('click', next);
      els.playBtn.addEventListener('click', playback);
      els.rerecordBtn.addEventListener('click', rerecord);
      els.discardAudioBtn.addEventListener('click', discardAudio);

      renderSentence();
    } catch (err) {
      els.loading.style.display = 'none';
      showError(err.message);
    }
  }

  init();
})();
