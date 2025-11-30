const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const freqEl = document.getElementById('freqValue');
const midiEl = document.getElementById('midiValue');
const confEl = document.getElementById('confValue');
const logEl = document.getElementById('log');

let audioCtx;
let mediaStream;
let sourceNode;
let workletNode;
let fallbackProcessor;
let zeroGain;

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${msg}\n` + logEl.textContent.slice(0, 2000);
}

function formatFreq(f) {
  return f ? `${f.toFixed(1)} Hz` : '-- Hz';
}
function formatMidi(midi) {
  return Number.isFinite(midi) ? midi.toFixed(2) : '--';
}
function formatConf(c) {
  return Number.isFinite(c) ? (c * 100).toFixed(1) + '%' : '--';
}

async function start() {
  if (audioCtx) return;
  log('開始ボタンが押されました');
  startBtn.disabled = true;
  statusEl.textContent = 'マイク許可を待っています...';

  // Basic secure-context check for user feedback
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    log('警告: マイク取得には https または localhost からのアクセスが必要です。');
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
  } catch (err) {
    statusEl.textContent = 'マイク許可が得られませんでした';
    log(`マイク取得失敗: ${err}`);
    startBtn.disabled = false;
    return;
  }

  audioCtx = new AudioContext({ latencyHint: 'interactive' });
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
      log('AudioContext を resume しました');
    } catch (err) {
      log(`AudioContext resume に失敗: ${err}`);
    }
  }
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  zeroGain = audioCtx.createGain();
  zeroGain.gain.value = 0;

  if (audioCtx.audioWorklet) {
    try {
      const workletUrl = await loadWorkletAsBlobUrl('pitch-worklet.js');
      await audioCtx.audioWorklet.addModule(workletUrl);
      workletNode = new AudioWorkletNode(audioCtx, 'pitch-processor');
      workletNode.port.onmessage = (event) => handleResult(event.data);
      sourceNode.connect(workletNode).connect(zeroGain).connect(audioCtx.destination);
      statusEl.textContent = 'AudioWorklet で計測中...';
      log('AudioWorklet で開始しました');
    } catch (err) {
      log(`AudioWorklet 読み込み失敗: ${err}. ScriptProcessor にフォールバックします。`);
      statusEl.textContent = 'Worklet 読み込み失敗、フォールバック中...';
      setupFallback();
    }
  } else {
    log('AudioWorklet 非対応。ScriptProcessor にフォールバックします。');
    setupFallback();
  }

  stopBtn.disabled = false;
}

async function loadWorkletAsBlobUrl(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Worklet fetch failed: ${res.status}`);
  const text = await res.text();
  const blob = new Blob([text], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

function setupFallback() {
  const processor = audioCtx.createScriptProcessor(2048, 1, 1);
  const frameSize = 2048;
  const hopSize = 512;
  const buffer = [];
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    for (let i = 0; i < input.length; i++) buffer.push(input[i]);
    while (buffer.length >= frameSize) {
      const frame = buffer.slice(0, frameSize);
      const res = detectYin(frame, audioCtx.sampleRate);
      handleResult({
        frequencyHz: res.frequency,
        midi: res.frequency ? 69 + 12 * Math.log2(res.frequency / 440) : null,
        confidence: res.confidence,
        timestamp: audioCtx.currentTime * 1000
      });
      buffer.splice(0, hopSize);
    }
  };
  fallbackProcessor = processor;
  sourceNode.connect(processor).connect(zeroGain).connect(audioCtx.destination);
  statusEl.textContent = 'ScriptProcessor で計測中...（遅延多め）';
}

function stop() {
  if (!audioCtx) return;
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (fallbackProcessor) {
    fallbackProcessor.disconnect();
    fallbackProcessor = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (zeroGain) {
    zeroGain.disconnect();
    zeroGain = null;
  }
  audioCtx.close();
  audioCtx = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  statusEl.textContent = '停止しました';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  log('停止しました');
}

function handleResult(data) {
  const { frequencyHz, midi, confidence } = data;
  freqEl.textContent = formatFreq(frequencyHz);
  midiEl.textContent = formatMidi(midi);
  confEl.textContent = formatConf(confidence);
  statusEl.textContent = frequencyHz ? '検出中...' : '入力が弱いか検出不能です';
}

// YIN detection for fallback
function detectYin(frame, sampleRate) {
  const frameSize = frame.length;
  const yinSize = Math.floor(frameSize / 2);
  const yin = new Float32Array(yinSize);
  let energy = 0;
  for (let i = 0; i < frameSize; i++) {
    energy += frame[i] * frame[i];
  }
  const rms = Math.sqrt(energy / frameSize);
  if (rms < 0.0002) return { frequency: null, confidence: 0 };

  for (let tau = 1; tau < yinSize; tau++) {
    let sum = 0;
    for (let i = 0; i < frameSize - tau; i++) {
      const delta = frame[i] - frame[i + tau];
      sum += delta * delta;
    }
    yin[tau] = sum;
  }

  yin[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < yinSize; tau++) {
    runningSum += yin[tau];
    yin[tau] = yin[tau] * tau / runningSum;
  }

  const threshold = 0.12;
  let tauEstimate = -1;
  for (let tau = 2; tau < yinSize; tau++) {
    if (yin[tau] < threshold) {
      while (tau + 1 < yinSize && yin[tau + 1] < yin[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate === -1) {
    let minVal = Infinity;
    for (let tau = 2; tau < yinSize; tau++) {
      if (yin[tau] < minVal) {
        minVal = yin[tau];
        tauEstimate = tau;
      }
    }
  }

  let betterTau = tauEstimate;
  if (tauEstimate > 0 && tauEstimate < yinSize - 1) {
    const s0 = yin[tauEstimate - 1];
    const s1 = yin[tauEstimate];
    const s2 = yin[tauEstimate + 1];
    const shift = (s2 - s0) / (2 * (2 * s1 - s2 - s0));
    betterTau = tauEstimate + shift;
  }

  const freq = sampleRate / betterTau;
  if (freq < 80 || freq > 800) return { frequency: null, confidence: 0 };
  const confidence = 1 - yin[tauEstimate];
  return { frequency: freq, confidence };
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
