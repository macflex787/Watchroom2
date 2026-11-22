# WatchRoom V2 — experimental media-source upgrade

This is a **separate test project**, derived from the supplied V1 ZIP. It retains the original Firebase room, chat, presence and WebRTC voice implementation. **Do not replace your working V1 repository.** It has not been tested end-to-end against your live Firebase/Cloudflare services.

## Implemented

- Host-selectable Google Drive preview fallback, direct HTTPS media URL, or R2-backed media URL.
- HTML5 `<video>` and `<audio>` controls for supported browser codecs. MP4 (H.264/AAC), WebM, and MP3 are good test choices. MKV/AVI/MOV/HEVC are **not universally playable**; convert/remux them first (examples below).
- Upload small files to R2 through a Cloudflare Worker using a password. No Google Drive video processing delay once upload finishes.
- Host can upload `.srt` or `.vtt` subtitle files (SRT converted to VTT client-side) to R2 and publish the track for everyone; alternatively paste a CORS-accessible HTTPS `.vtt` URL. For direct video only.
- No automatic synchronized playback. The existing chat/voice is unchanged.
- PC streaming **as a direct HTTPS URL source**: you must independently run a secure HTTPS-accessible media server or tunnel; this ZIP does not create a tunnel or a PC companion service. Never expose a private PC directory or unauthenticated server to the Internet.

## Firebase test setup

1. Make a **new GitHub repo** and preferably a **new Firebase project** for testing. Enable Anonymous Authentication and Realtime Database.
2. Put your Firebase web configuration into `config.js` (the placeholder is safe to commit, but your real Firebase config is public anyway; database security rules are essential).
3. Paste `database.rules.json` into the **new** Firebase Realtime Database Rules tab. It adds a host-only `subtitle` node to the V1 rules. **Never apply these rules blindly to the production V1 database.**
4. GitHub Pages: deploy the root files (`index.html`, `app.js`, `styles.css`, `config.js`, `media-config.js`). If you place the files in a subfolder, set Pages accordingly.

## Cloudflare R2 setup

1. Create a Cloudflare account, an R2 bucket named `watchroom-v2-media` (R2 may require billing setup). Install Node.js and run `npm install -g wrangler` or use `npx wrangler`.
2. In `worker/`, rename `wrangler.toml.example` to `wrangler.toml`, replace `YOUR-USERNAME` with your GitHub username (e.g. `https://example.github.io`), and check the bucket name. Keep your `UPLOAD_SECRET` out of source control.
3. Run `npx wrangler login`, then `npx wrangler secret put UPLOAD_SECRET` (choose a long random password), then `npx wrangler deploy` from `worker/`.
4. Put the resulting `https://...workers.dev` URL into `media-config.js` and deploy your website. The browser uses the password **only when the host uploads**; it is not saved in Firebase.
5. Open the new site, create a room, select a small H.264/AAC MP4 or MP3, enter your upload password, and click **Upload to R2 and play**. Test from another browser/device. Test subtitle upload with an `.srt` file. The video should become available after upload completes; no Drive preview processing is involved.

**Important limits:** This demonstration uses one HTTP PUT request and deliberately limits browser uploads to **90 MiB**. Cloudflare Workers have plan-dependent request-body limits; 90 MiB is chosen to stay below the common 100 MB limit. It does **not** yet implement multipart/resumable browser uploads. For full-length movies, use an S3-compatible multipart upload client to upload the object to the bucket under a key shaped like `UUID/filename.mp4`, then use the **Direct HTTPS URL** mode only if you separately provide a safe streaming endpoint; the current interface has no 'select existing R2 object' control. Large-file uploads and object selection are a next development milestone. **Do not interpret V2 as supporting 2+ GB uploads yet.**

## Media formats and conversion

- Direct browser playback depends on codecs, not just file extensions. A `.mkv` may work in some browsers but will not be reliable across devices.
- With FFmpeg installed, for a compatible H.264/AAC MKV, try fast remuxing: `ffmpeg -i input.mkv -map 0:v:0 -map 0:a:0? -c copy -movflags +faststart output.mp4` (some shell environments need the `?` quoted).
- Otherwise transcode: `ffmpeg -i input.mkv -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 160k -movflags +faststart output.mp4`.
- MP3 is audio, not video. MP4 with H.264/AAC is the most portable video target.

## Security and limitations (read before sharing)

- The Worker protects **uploads** using a secret. **Media GET URLs are not authenticated**; the object key is hard to guess but **anyone who obtains a media URL can access it**. Do not use this demo for sensitive/private media. For production, add room-scoped signed URLs, access checks, expirations, abuse protection and cleanup.
- The Firebase V1 rules allow anyone with a room ID and anonymous sign-in to read room data; room links are bearer invitations, not identity-based access control.
- A browser is not a transcoder. V2 does not automatically convert MKV/AVI/MOV or support arbitrary codecs.
- R2 egress and Worker request costs/quotas can apply; check current pricing and limits before use.
- Subtitles depend on the R2 Worker serving `text/vtt` with correct CORS. Upload subtitles separately from media. Only one subtitle track is supported in this iteration; no automatic matching of filenames yet.
- Direct URLs must permit cross-origin playback and range requests; PC URLs must be public HTTPS, not `file://`, `localhost`, or private LAN addresses.
- Voice still uses STUN-only WebRTC and may fail on restrictive networks. The same caveat applies to V1.
- A failed R2 stream does not automatically switch to Drive or PC; the host explicitly chooses the source.

## Test checklist

- [ ] New Firebase room created and link opens on another device
- [ ] Text chat, presence, voice work between two browsers
- [ ] Drive preview fallback plays a previously processed video
- [ ] R2 upload of 10–50 MiB MP4 succeeds and both participants can play
- [ ] MP3 playback works
- [ ] SRT subtitles appear in direct video and fullscreen
- [ ] Direct HTTPS media URL plays from a second device
- [ ] Invalid upload password fails safely
- [ ] Original V1 GitHub repository and Firebase database remain untouched

## Next iteration

Add authenticated/signed playback URLs, browser multipart uploads for multi-GB videos, media library/selection, automatic subtitle filename matching and format conversion, and optionally a secure PC companion streamer. These features are **not included** in this ZIP.
