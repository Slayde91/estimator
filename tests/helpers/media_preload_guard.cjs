"use strict";

// Chromium can cancel a native media request during preload or later playback
// and seeking. Stage is diagnostic; exact delivery and fresh retained-player
// decoding evidence determine whether that cancellation is benign.
function verifiedNativeMediaCancellation(request, { origin, paths, media, assets, hashes, capturedAt } = {}) {
  if (request?.method !== "GET" || request.resourceType !== "media"
      || request.failure?.errorText !== "net::ERR_ABORTED") return false;
  if (!Array.isArray(paths) || !Array.isArray(media) || !Array.isArray(assets) || !hashes) return false;
  const failedAt = Date.parse(request.observedAt), proofAt = Date.parse(capturedAt);
  if (!Number.isFinite(failedAt) || !Number.isFinite(proofAt) || proofAt < failedAt) return false;
  const source = paths.find(path => `${origin}${path}` === request.url);
  if (!source) return false;
  const mime = source.endsWith(".mp3") ? "audio/mpeg" : source.endsWith(".wav") ? "audio/wav" : source.endsWith(".ogg") ? "audio/ogg" : null;
  if (!mime) return false;
  const expected = hashes[`static${source}`];
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const asset = assets.find(asset => asset.url === request.url);
  if (!asset || asset.status !== 200 || asset.contentType !== mime || asset.sha256 !== expected
      || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) return false;
  const player = media.find(player => player.url === request.url);
  return !!player && player.error === null && player.readyState >= 2 && Number.isFinite(player.duration) && player.duration > 0
    && Array.isArray(player.events) && player.events.some(event => event.type === "loadeddata" && event.trusted === true)
    && !player.events.some(event => event.type === "error" || event.error);
}

module.exports = { verifiedNativeMediaCancellation };
