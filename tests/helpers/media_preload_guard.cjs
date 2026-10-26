"use strict";

// A native media-loader cancellation is benign only when the same packaged
// asset has independently passed delivery and trusted decoding checks.
function verifiedPreloadCancellation(request, { origin, paths, preloads, assets, hashes }) {
  if (request?.stage !== "initial load" || request.method !== "GET" || request.resourceType !== "media"
      || request.failure?.errorText !== "net::ERR_ABORTED") return false;
  const source = paths.find(path => `${origin}${path}` === request.url);
  if (!source) return false;
  const expected = hashes[`static${source}`];
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const asset = assets.find(asset => asset.url === request.url);
  if (!asset || asset.status !== 200 || asset.contentType !== "audio/mpeg" || asset.sha256 !== expected
      || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) return false;
  const media = preloads.find(media => media.url === request.url);
  return !!media && media.error === null && media.readyState >= 2 && Number.isFinite(media.duration) && media.duration > 0
    && Array.isArray(media.events) && media.events.some(event => event.type === "loadeddata" && event.trusted === true)
    && !media.events.some(event => event.type === "error" || event.error);
}

module.exports = { verifiedPreloadCancellation };
