'use strict';

// Availability probe for the external media binaries (ffmpeg/ffprobe) that video
// thumbnail + duration extraction depends on. They are SYSTEM dependencies, not npm
// ones, so a deployment can easily lack them — and content-ingest's best-effort
// contract means every video then uploads fine but silently gets no thumbnail and
// no duration. Probed once and cached: the answer can't change without an operator
// installing packages, which comes with a restart anyway.
//
// Async on purpose: the first caller is server.js right after listen, and a hung
// binary (NFS-mounted PATH shim, broken wrapper) must degrade to a late log line,
// not block request serving on a freshly-bound port.

const { execFile } = require('child_process');

let cached = null;

function probeTool(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

function mediaToolStatus() {
  if (!cached) {
    cached = Promise.all([probeTool('ffmpeg'), probeTool('ffprobe')])
      .then(([ffmpeg, ffprobe]) => ({ ffmpeg, ffprobe }));
  }
  return cached;
}

module.exports = { mediaToolStatus };
