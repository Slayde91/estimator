const { createDownloadSound } = require('../../static/header-menu-sounds.js');

// Use the production compatibility controller and observe any media access.
function downloadSoundHarness() {
  let audioAttempts = 0;
  const sound = createDownloadSound({ get Audio() { audioAttempts++; throw Error('Downloads must not access media'); } });
  return { sound, get audioAttempts() { return audioAttempts; } };
}
module.exports = { downloadSoundHarness };
