import createModule from './decoder/libopenmpt.worklet.js';

// The packaged build embeds its WASM bytes: no streaming MIME or cross-origin isolation is required.
const library = createModule();
class NexusProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mod = 0; this.left = 0; this.right = 0; this.paused = true; this.serial = 0; this.frames = 0;
    this.port.onmessage = ({ data }) => this.command(data);
    library.then(lib => { this.lib = lib; this.port.postMessage({ type: 'ready' }); }).catch(() => this.port.postMessage({ type: 'error', message: 'WASM initialization failed.' }));
  }
  release() {
    if (this.mod) this.lib._openmpt_module_destroy(this.mod);
    if (this.left) this.lib._free(this.left);
    if (this.right) this.lib._free(this.right);
    this.mod = this.left = this.right = 0; this.paused = true;
  }
  metadata(key) {
    const l = this.lib; const ptr = l._malloc(key.length + 1);
    for (let i = 0; i < key.length; i++) l.HEAPU8[ptr + i] = key.charCodeAt(i);
    l.HEAPU8[ptr + key.length] = 0;
    const value = l._openmpt_module_get_metadata(this.mod, ptr); l._free(ptr);
    const text = l.UTF8ToString(value); l._openmpt_free_string(value); return text;
  }
  command(data) {
    if (!this.lib) return;
    try {
      if (data.type === 'load') {
        this.release(); this.serial = data.serial;
        const l = this.lib, bytes = new Uint8Array(data.bytes), ptr = l._malloc(bytes.length);
        if (!ptr) throw new Error('Not enough memory.');
        l.HEAPU8.set(bytes, ptr);
        try { this.mod = l._openmpt_module_create_from_memory(ptr, bytes.length, 0, 0, 0); }
        finally { l._free(ptr); }
        if (!this.mod) throw new Error('The decoder does not recognize this module.');
        this.left = l._malloc(128 * 4); this.right = l._malloc(128 * 4);
        if (!this.left || !this.right) throw new Error('Not enough audio memory.');
        l._openmpt_module_set_repeat_count(this.mod, 0);
        this.paused = false; this.frames = 0;
        this.port.postMessage({ type: 'loaded', serial: this.serial, duration: l._openmpt_module_get_duration_seconds(this.mod), title: this.metadata('title'), artist: this.metadata('artist'), format: this.metadata('type'), channels: l._openmpt_module_get_num_channels(this.mod) });
      } else if (data.type === 'stop') { this.release(); this.serial = data.serial; }
      else if (data.serial === this.serial && this.mod) {
        if (data.type === 'pause') this.paused = data.paused;
        if (data.type === 'seek') this.lib._openmpt_module_set_position_seconds(this.mod, data.position);
      }
    } catch (error) {
      this.release(); this.port.postMessage({ type: 'error', serial: this.serial, message: error.message || 'Decoding failed.' });
    }
  }
  process(_inputs, outputs) {
    if (!this.mod || this.paused) return true;
    const left = outputs[0][0], right = outputs[0][1];
    try {
      const count = this.lib._openmpt_module_read_float_stereo(this.mod, sampleRate, left.length, this.left, this.right);
      if (!count) { this.paused = true; this.port.postMessage({ type: 'ended', serial: this.serial }); return true; }
      left.set(this.lib.HEAPF32.subarray(this.left / 4, this.left / 4 + count));
      right.set(this.lib.HEAPF32.subarray(this.right / 4, this.right / 4 + count));
      this.frames += count;
      if (this.frames >= sampleRate / 10) {
        this.frames = 0;
        this.port.postMessage({ type: 'position', serial: this.serial, position: this.lib._openmpt_module_get_position_seconds(this.mod) });
      }
    } catch { this.release(); this.port.postMessage({ type: 'error', serial: this.serial, message: 'Audio rendering was interrupted.' }); }
    return true;
  }
}
registerProcessor('nexus-decoder', NexusProcessor);
