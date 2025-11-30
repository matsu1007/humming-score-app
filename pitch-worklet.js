// AudioWorkletProcessor: YIN-based pitch detection
// Runs on the audio rendering thread and posts PitchResult messages to the main thread.

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = 2048;
    this.hopSize = 256;
    this.minFreq = 80;
    this.maxFreq = 800;
    this.threshold = 0.12;
    this.energyThreshold = 0.0002;
    this.buffer = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    // Accumulate samples
    for (let i = 0; i < channel.length; i++) {
      this.buffer.push(channel[i]);
    }

    // Run YIN when we have enough samples
    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.slice(0, this.frameSize);
      const result = this.detectPitch(frame);
      this.port.postMessage({
        frequencyHz: result.frequency,
        midi: result.frequency ? 69 + 12 * Math.log2(result.frequency / 440) : null,
        confidence: result.confidence,
        timestamp: currentTime * 1000
      });
      // Drop hopSize samples to advance
      this.buffer.splice(0, this.hopSize);
    }

    return true;
  }

  detectPitch(frame) {
    const yinSize = Math.floor(this.frameSize / 2);
    const yin = new Float32Array(yinSize);
    let energy = 0;

    // Difference function
    for (let i = 0; i < this.frameSize; i++) {
      energy += frame[i] * frame[i];
    }
    const rms = Math.sqrt(energy / this.frameSize);
    if (rms < this.energyThreshold) {
      return { frequency: null, confidence: 0 };
    }

    for (let tau = 1; tau < yinSize; tau++) {
      let sum = 0;
      for (let i = 0; i < this.frameSize - tau; i++) {
        const delta = frame[i] - frame[i + tau];
        sum += delta * delta;
      }
      yin[tau] = sum;
    }

    // Cumulative mean normalized difference
    yin[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < yinSize; tau++) {
      runningSum += yin[tau];
      yin[tau] = yin[tau] * tau / runningSum;
    }

    // Absolute threshold
    let tauEstimate = -1;
    for (let tau = 2; tau < yinSize; tau++) {
      if (yin[tau] < this.threshold) {
        while (tau + 1 < yinSize && yin[tau + 1] < yin[tau]) {
          tau++;
        }
        tauEstimate = tau;
        break;
      }
    }

    if (tauEstimate === -1) {
      // No crossing found; pick minimum
      let minVal = Infinity;
      for (let tau = 2; tau < yinSize; tau++) {
        if (yin[tau] < minVal) {
          minVal = yin[tau];
          tauEstimate = tau;
        }
      }
    }

    // Parabolic interpolation for better accuracy
    let betterTau = tauEstimate;
    if (tauEstimate > 0 && tauEstimate < yinSize - 1) {
      const s0 = yin[tauEstimate - 1];
      const s1 = yin[tauEstimate];
      const s2 = yin[tauEstimate + 1];
      const shift = (s2 - s0) / (2 * (2 * s1 - s2 - s0));
      betterTau = tauEstimate + shift;
    }

    const freq = sampleRate / betterTau;
    if (freq < this.minFreq || freq > this.maxFreq) {
      return { frequency: null, confidence: 0 };
    }
    const confidence = 1 - yin[tauEstimate];
    return { frequency: freq, confidence: confidence };
  }
}

registerProcessor('pitch-processor', PitchProcessor);
