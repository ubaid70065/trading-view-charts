/**
 * Workspace snapshot.
 *
 * The charts live in cross-origin iframes, so they cannot be drawn to a canvas —
 * `drawImage` on a foreign frame is not possible and html2canvas-style tricks
 * cannot reach inside either. The only way to capture the composed workspace is
 * the Screen Capture API, which means the browser asks the user to pick this tab.
 *
 * Each chart's own toolbar also has a camera button that exports just that chart
 * with no permission prompt; this covers the whole layout at once.
 */

/**
 * @param {string} filename Base name, without extension.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function captureWorkspace(filename) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        return { ok: false, reason: 'This browser cannot capture the screen. Use the camera button in a chart’s toolbar instead.' };
    }

    let stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: 'browser' },
            audio: false,
            // Hints the picker towards the current tab.
            preferCurrentTab: true,
        });
    } catch (error) {
        // A cancelled picker is a normal outcome, not a failure worth shouting about.
        const cancelled = error && (error.name === 'NotAllowedError' || error.name === 'AbortError');
        return { ok: false, reason: cancelled ? '' : `Capture failed: ${error.message}` };
    }

    try {
        const track = stream.getVideoTracks()[0];
        if (!track) return { ok: false, reason: 'No video track was returned by the capture.' };

        const bitmap = await grabFrame(track, stream);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        if (typeof bitmap.close === 'function') bitmap.close();

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) return { ok: false, reason: 'The frame could not be encoded to PNG.' };

        download(blob, `${filename}.png`);
        return { ok: true };
    } finally {
        for (const track of stream.getTracks()) track.stop();
    }
}

/**
 * ImageCapture.grabFrame is the direct route but is not in Safari, so fall back
 * to painting one frame from a hidden <video>.
 */
async function grabFrame(track, stream) {
    if (typeof window.ImageCapture === 'function') {
        try {
            return await new window.ImageCapture(track).grabFrame();
        } catch {
            // Fall through to the video route.
        }
    }

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // One rendered frame is needed before the video has real dimensions.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    video.pause();
    video.srcObject = null;

    return await createImageBitmap(canvas);
}

function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}
