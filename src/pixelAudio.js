const STORAGE_KEY = "blockstep.audio.muted";

const ACTION_FREQUENCIES = Object.freeze({
  stay: 164.81,
  up: 392,
  right: 440,
  down: 329.63,
  left: 293.66,
  flip: 523.25,
});

function readStoredMute(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredMute(storage, muted) {
  try {
    storage?.setItem(STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // Audio still works when storage is unavailable or blocked.
  }
}

function softClipCurve(amount = 18) {
  const curve = new Float32Array(512);
  for (let index = 0; index < curve.length; index += 1) {
    const x = (index * 2) / (curve.length - 1) - 1;
    curve[index] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

export function createPixelAudioSystem({
  AudioContextClass = globalThis.window?.AudioContext ?? globalThis.window?.webkitAudioContext,
  storage = globalThis.window?.localStorage,
} = {}) {
  let context = null;
  let input = null;
  let muted = readStoredMute(storage);
  let seed = 0x42e17a9d;

  function random() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  }

  function ensureContext() {
    if (context) return context;
    if (!AudioContextClass) return null;
    context = new AudioContextClass();
    input = context.createGain();
    const shaper = context.createWaveShaper();
    const compressor = context.createDynamicsCompressor();
    const master = context.createGain();
    shaper.curve = softClipCurve();
    shaper.oversample = "2x";
    compressor.threshold.value = -20;
    compressor.knee.value = 10;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.16;
    master.gain.value = muted ? 0 : 0.22;
    input.connect(shaper);
    shaper.connect(compressor);
    compressor.connect(master);
    master.connect(context.destination);
    input.masterGain = master;
    return context;
  }

  async function unlock() {
    const active = ensureContext();
    if (!active) return false;
    if (active.state === "suspended") await active.resume();
    return active.state === "running";
  }

  function tone(frequency, {
    delay = 0,
    duration = 0.08,
    gain = 0.06,
    type = "square",
    endFrequency = frequency,
    detune = 0,
  } = {}) {
    if (!context || context.state !== "running") return;
    const start = context.currentTime + delay;
    const stop = start + duration;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(1, frequency), start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), stop);
    oscillator.detune.setValueAtTime(detune, start);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.008, duration / 3));
    envelope.gain.exponentialRampToValueAtTime(0.0001, stop);
    oscillator.connect(envelope);
    envelope.connect(input);
    oscillator.start(start);
    oscillator.stop(stop + 0.02);
  }

  function noise({ delay = 0, duration = 0.09, gain = 0.06, frequency = 900, q = 1.2 } = {}) {
    if (!context || context.state !== "running") return;
    const start = context.currentTime + delay;
    const frameCount = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, frameCount, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < frameCount; index += 1) {
      const decay = 1 - index / frameCount;
      data[index] = (random() * 2 - 1) * decay;
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    filter.type = "bandpass";
    filter.frequency.value = frequency;
    filter.Q.value = q;
    envelope.gain.setValueAtTime(gain, start);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(input);
    source.start(start);
  }

  function playUiConfirm() {
    tone(329.63, { duration: 0.05, gain: 0.035, type: "square" });
    tone(659.25, { delay: 0.035, duration: 0.07, gain: 0.045, type: "triangle" });
  }

  function playQueue(action) {
    const base = ACTION_FREQUENCIES[action] ?? ACTION_FREQUENCIES.stay;
    tone(base * 2, {
      duration: action === "flip" ? 0.1 : 0.035,
      gain: action === "stay" ? 0.018 : 0.03,
      type: action === "flip" ? "triangle" : "square",
      endFrequency: action === "flip" ? base * 3 : base * 1.7,
    });
  }

  function playCountdown(value) {
    if (value === "GO" || value === 0) {
      tone(440, { duration: 0.1, gain: 0.07, type: "square", endFrequency: 880 });
      tone(880, { delay: 0.07, duration: 0.13, gain: 0.075, type: "triangle" });
      return;
    }
    const frequency = 196 + (3 - Number(value)) * 24;
    tone(frequency, { duration: 0.08, gain: 0.05, type: "square", endFrequency: frequency * 0.82 });
    noise({ duration: 0.025, gain: 0.018, frequency: 1200 });
  }

  function playBeat({ action, echoAction = null, event = "safe", hasPulse = false } = {}) {
    const base = ACTION_FREQUENCIES[action] ?? ACTION_FREQUENCIES.stay;
    tone(base, {
      duration: action === "flip" ? 0.18 : 0.055,
      gain: action === "stay" ? 0.028 : 0.052,
      type: action === "flip" ? "triangle" : "square",
      endFrequency: action === "flip" ? base * 2 : base * 0.92,
    });

    if (echoAction) {
      const returned = ACTION_FREQUENCIES[echoAction] ?? ACTION_FREQUENCIES.stay;
      tone(returned * 0.5, {
        delay: 0.018,
        duration: 0.15,
        gain: 0.064,
        type: "sawtooth",
        endFrequency: returned * 0.28,
        detune: -16,
      });
      noise({ delay: 0.025, duration: 0.055, gain: 0.028, frequency: 520 });
    }

    if (hasPulse) {
      tone(82.41, { duration: 0.22, gain: 0.085, type: "sawtooth", endFrequency: 55 });
      tone(164.81, { delay: 0.03, duration: 0.12, gain: 0.035, type: "square", endFrequency: 82.41 });
    }

    if (event === "hit" || event === "hit-and-shard") {
      noise({ duration: 0.22, gain: 0.12, frequency: 260, q: 0.7 });
      tone(123.47, { duration: 0.24, gain: 0.1, type: "sawtooth", endFrequency: 52 });
    }
    if (event === "shard" || event === "hit-and-shard") {
      tone(659.25, { delay: 0.02, duration: 0.08, gain: 0.065, type: "square", endFrequency: 987.77 });
      tone(987.77, { delay: 0.085, duration: 0.13, gain: 0.075, type: "triangle", endFrequency: 1318.51 });
    } else if (event === "close-call") {
      tone(740, { delay: 0.02, duration: 0.045, gain: 0.038, type: "sine", endFrequency: 880 });
      tone(880, { delay: 0.065, duration: 0.05, gain: 0.028, type: "sine", endFrequency: 740 });
    }
  }

  function playResult(won) {
    const notes = won ? [440, 554.37, 659.25, 880] : [220, 185, 146.83, 92.5];
    notes.forEach((frequency, index) => {
      tone(frequency, {
        delay: index * 0.085,
        duration: won ? 0.2 : 0.16,
        gain: 0.07,
        type: won ? "triangle" : "sawtooth",
        endFrequency: won ? frequency * 1.08 : frequency * 0.72,
      });
    });
    if (!won) noise({ delay: 0.1, duration: 0.26, gain: 0.065, frequency: 180, q: 0.6 });
  }

  function setMuted(nextMuted) {
    muted = Boolean(nextMuted);
    writeStoredMute(storage, muted);
    if (input?.masterGain && context) {
      input.masterGain.gain.setTargetAtTime(muted ? 0 : 0.22, context.currentTime, 0.018);
    }
    return muted;
  }

  function toggleMute() {
    const next = setMuted(!muted);
    if (!next) playUiConfirm();
    return next;
  }

  return {
    unlock,
    playUiConfirm,
    playQueue,
    playCountdown,
    playBeat,
    playResult,
    setMuted,
    toggleMute,
    isMuted: () => muted,
    isAvailable: () => Boolean(AudioContextClass),
    isUnlocked: () => context?.state === "running",
  };
}

