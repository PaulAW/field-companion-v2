/* camera-capture.js — In-page live camera capture.
   Avoids handing off to the native camera app: on Android, that separate
   activity can get the browser tab's process killed under memory pressure,
   silently losing the photo when the page has to fully reload. Staying on
   this page via getUserMedia sidesteps that. Falls back to the native
   camera-app file input (via the caller's onError) when unsupported. */

var CameraCapture = (() => {
  let _stream    = null;
  let _onCapture = null;

  function isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function init() {
    const cancelBtn  = document.getElementById('camera-capture-cancel');
    const shutterBtn = document.getElementById('camera-capture-shutter');
    if (cancelBtn)  cancelBtn.addEventListener('click', () => close());
    if (shutterBtn) shutterBtn.addEventListener('click', capture);
  }

  async function requestStream() {
    const attempts = [
      { video: { facingMode: { exact: 'environment' } }, audio: false },
      { video: { facingMode: 'environment' }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr;
    for (const c of attempts) {
      try { return await navigator.mediaDevices.getUserMedia(c); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No camera available');
  }

  async function open(onCapture, onError) {
    _onCapture = onCapture;
    const modal = document.getElementById('camera-capture-modal');
    const video = document.getElementById('camera-capture-video');
    if (!modal || !video) { if (onError) onError(); return; }

    try {
      _stream = await requestStream();
    } catch (e) {
      if (window.App) App.toast('Camera unavailable — opening your phone\'s camera app instead');
      if (onError) onError();
      return;
    }

    video.srcObject = _stream;
    modal.style.display = 'flex';
    try { await video.play(); } catch (e) {}
  }

  function capture() {
    const video = document.getElementById('camera-capture-video');
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const cb = _onCapture;
    close();
    if (cb) cb(dataUrl);
  }

  function close() {
    const modal = document.getElementById('camera-capture-modal');
    const video = document.getElementById('camera-capture-video');
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
    if (video) video.srcObject = null;
    if (modal) modal.style.display = 'none';
    _onCapture = null;
  }

  return { init, isSupported, open, close };
})();
