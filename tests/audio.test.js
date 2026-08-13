import test from "node:test";
import assert from "node:assert/strict";

import { createPixelAudioSystem } from "../src/pixelAudio.js";

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(value, time) { this.value = value; this.events.push(["set", value, time]); }
  exponentialRampToValueAtTime(value, time) { this.value = value; this.events.push(["exp", value, time]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(["target", value, time, constant]); }
}

class FakeNode {
  constructor() {
    this.gain = new FakeParam(1);
    this.frequency = new FakeParam(440);
    this.detune = new FakeParam(0);
    this.Q = new FakeParam(1);
    this.threshold = new FakeParam();
    this.knee = new FakeParam();
    this.ratio = new FakeParam();
    this.attack = new FakeParam();
    this.release = new FakeParam();
  }
  connect(target) { this.target = target; return target; }
  start(time) { this.startedAt = time; }
  stop(time) { this.stoppedAt = time; }
}

class FakeAudioContext {
  static latest = null;
  constructor() {
    FakeAudioContext.latest = this;
    this.state = "suspended";
    this.currentTime = 12;
    this.sampleRate = 8_000;
    this.destination = new FakeNode();
    this.oscillators = [];
    this.buffers = [];
  }
  async resume() { this.state = "running"; }
  createGain() { return new FakeNode(); }
  createWaveShaper() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createOscillator() { const node = new FakeNode(); this.oscillators.push(node); return node; }
  createBiquadFilter() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createBuffer(channels, frames) {
    const data = new Float32Array(frames);
    this.buffers.push(data);
    return { getChannelData: () => data };
  }
}

test("procedural pixel cues unlock on user action and cover every gameplay event", async () => {
  const stored = new Map();
  const audio = createPixelAudioSystem({
    AudioContextClass: FakeAudioContext,
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  });
  assert.equal(audio.isUnlocked(), false);
  assert.equal(await audio.unlock(), true);
  audio.playUiConfirm();
  audio.playCountdown(3);
  audio.playCountdown("GO");
  audio.playQueue("left");
  audio.playQueue("flip");
  audio.playBeat({ action: "up", echoAction: "left", event: "safe", hasPulse: true });
  audio.playBeat({ action: "right", echoAction: "up", event: "shard", hasPulse: false });
  audio.playBeat({ action: "down", echoAction: "right", event: "hit-and-shard", hasPulse: true });
  audio.playBeat({ action: "stay", event: "close-call" });
  audio.playResult(true);
  audio.playResult(false);
  assert.ok(FakeAudioContext.latest.oscillators.length >= 20);
  assert.ok(FakeAudioContext.latest.buffers.length >= 4);
  assert.equal(audio.toggleMute(), true);
  assert.equal(stored.get("blockstep.audio.muted"), "1");
  assert.equal(audio.toggleMute(), false);
  assert.equal(stored.get("blockstep.audio.muted"), "0");
});

test("audio remains a safe no-op when Web Audio is unavailable", async () => {
  const audio = createPixelAudioSystem({ AudioContextClass: null, storage: null });
  assert.equal(audio.isAvailable(), false);
  assert.equal(await audio.unlock(), false);
  assert.doesNotThrow(() => audio.playBeat({ action: "up", event: "hit", hasPulse: true }));
  assert.equal(audio.toggleMute(), true);
});

