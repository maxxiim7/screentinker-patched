# Bundled media tools (ffprobe, ffmpeg)

`ffprobe.gz` and `ffmpeg.gz` are gzipped aarch64 binaries shipped in the **BrightSign player package
only**. `bs-server-boot.js` unpacks them into `/tmp/screentinker-bin` at boot — every writable volume
on a BrightSign player is mounted `noexec`, so a copy onto tmpfs is the only way to execute anything
— and puts that directory on `PATH` so the server's normal ffprobe/ffmpeg lookups find them.

## What they are

Unmodified **FFmpeg 7.1.1** (<https://ffmpeg.org/>), licensed **LGPL 2.1 or later**. See
`COPYING.LGPLv2.1` in this directory, which ships beside the binaries in the package.

Configured `--disable-gpl`, so **no GPL component is present**, including `libpostproc` (GPL-only).
This is deliberate: it keeps the shipped tree free of copyleft beyond the LGPL, which the licence
position for underwriting and procurement depends on.

## Rebuilding them

Cross-built on Ubuntu with `aarch64-linux-gnu-gcc`. ffprobe carries **no decoders** — duration and
stream geometry come from the container — which is why it is 1.8MB against ffmpeg's 4.9MB.

```sh
./configure \
  --arch=aarch64 --target-os=linux --enable-cross-compile \
  --cross-prefix=aarch64-linux-gnu- \
  --disable-gpl --disable-nonfree --disable-autodetect \
  --disable-shared --enable-static --enable-small \
  --disable-doc --disable-network --disable-debug --disable-ffplay \
  --extra-version="ScreenTinker" \
  --disable-everything \
  --enable-demuxer=mov,matroska,mp3,image2,wav,avi,flv,mpegts,ogg,aac \
  --enable-muxer=image2,mjpeg \
  --enable-decoder=h264,hevc,vp8,vp9,av1,mpeg4,mjpeg,aac,mp3,vorbis,opus,pcm_s16le \
  --enable-encoder=mjpeg \
  --enable-parser=h264,hevc,vp8,vp9,av1,mpeg4video,mjpeg,mpegaudio,aac \
  --enable-filter=scale,transpose,hflip,vflip,format,null,copy,crop,setsar \
  --enable-protocol=file --enable-swscale \
  --extra-cflags="-Os -ffunction-sections -fdata-sections" \
  --extra-ldflags="-static -Wl,--gc-sections"
make -j"$(nproc)" ffmpeg ffprobe
gzip -9 -c ffprobe > brightsign/media-tools/ffprobe.gz
gzip -9 -c ffmpeg  > brightsign/media-tools/ffmpeg.gz
```

Test the result with `qemu-aarch64-static ./ffprobe -version` before putting it near a device.

## ⚠️ Do not substitute a distribution build

A stock Debian `ffprobe` linked against BrightSignOS's own libav stack starts, prints its banner, and
then **SIGSEGVs** on the first file it opens: their Yocto build is patched for hardware decode.
Debian's is also built `--enable-gpl`. These binaries deliberately link nothing of the platform's.

## LGPL section 6

These are statically linked, so the licence requires that we can supply the corresponding source and
the object files needed to relink against a modified library. The configure line above plus the
upstream 7.1.1 tarball reproduces them exactly; the written offer is published at
<https://screentinker.com/legal/third-party.html>.
