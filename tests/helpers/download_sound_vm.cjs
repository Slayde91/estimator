const { createDownloadSound } = require('../../static/header-menu-sounds.js');

// Real sound ownership/token code with a controllable decoded media endpoint.
function downloadSoundHarness() {
  let audio;
  const sound = createDownloadSound({ Audio: class {
    constructor() { audio = this; this.readyState = 4; this.currentTime = 0; this.paused = true; this.plays = 0; }
    load() {}
    pause() { this.paused = true; }
    play() { this.plays++; this.paused = false; return Promise.resolve(); }
  } });
  return { sound, audio };
}
module.exports = { downloadSoundHarness };
