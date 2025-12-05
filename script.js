// --- Variables ---
const video = document.getElementById('sourceVideo');
const canvas = document.getElementById('glCanvas');
const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: false });
const fileInput = document.getElementById('videoUpload');
const btnPlay = document.getElementById('btnPlay');
const btnRecord = document.getElementById('btnRecord');

const statusPanel = document.getElementById('statusPanel');
const statusText = document.getElementById('statusText');
const statusTimer = document.getElementById('statusTimer');
const conversionProgress = document.getElementById('conversionProgress');
const conversionBar = document.getElementById('conversionBar');

// FFmpeg Instance
const { createFFmpeg, fetchFile } = FFmpeg;
let ffmpeg = null;

const sliders = {
    sharpen: document.getElementById('param-sharpen'),
    denoise: document.getElementById('param-denoise'),
    contrast: document.getElementById('param-contrast')
};
const values = {
    sharpen: document.getElementById('val-sharpen'),
    denoise: document.getElementById('val-denoise'),
    contrast: document.getElementById('val-contrast')
};

let isPlaying = false;
let isRecording = false;
let isUpscaled = false;
let mediaRecorder;
let recordedChunks = [];
let animationId;
let sourceWidth = 0;
let sourceHeight = 0;
let timerInterval;

// --- WebGL Shaders (Same as before) ---
const vsSource = `attribute vec2 a_position; attribute vec2 a_texCoord; varying vec2 v_texCoord; void main() { gl_Position = vec4(a_position, 0, 1); v_texCoord = a_texCoord; }`;
const fsSource = `
    precision mediump float;
    uniform sampler2D u_image;
    uniform vec2 u_textureSize;
    varying vec2 v_texCoord;
    uniform float u_sharpen;
    uniform float u_denoise;
    uniform float u_contrast;

    void main() {
        vec2 onePixel = vec2(1.0, 1.0) / u_textureSize;
        vec4 color = texture2D(u_image, v_texCoord);
        
        vec4 colorL = texture2D(u_image, v_texCoord + vec2(-onePixel.x, 0));
        vec4 colorR = texture2D(u_image, v_texCoord + vec2(onePixel.x, 0));
        vec4 colorU = texture2D(u_image, v_texCoord + vec2(0, -onePixel.y));
        vec4 colorD = texture2D(u_image, v_texCoord + vec2(0, onePixel.y));
        
        vec4 blur = (color + colorL + colorR + colorU + colorD) / 5.0;
        vec4 denoisedColor = mix(color, blur, u_denoise);

        vec4 edge = texture2D(u_image, v_texCoord + vec2(0, -onePixel.y)) +
                    texture2D(u_image, v_texCoord + vec2(-onePixel.x, 0)) +
                    texture2D(u_image, v_texCoord + vec2(onePixel.x, 0)) +
                    texture2D(u_image, v_texCoord + vec2(0, onePixel.y));
        
        vec4 sharpened = denoisedColor + (denoisedColor * 4.0 - edge) * u_sharpen;
        vec3 finalColor = (sharpened.rgb - 0.5) * u_contrast + 0.5;
        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

// --- Init WebGL ---
function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
}
const program = gl.createProgram();
gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vsSource));
gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fsSource));
gl.linkProgram(program);

const positionLocation = gl.getAttribLocation(program, "a_position");
const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");
const textureSizeLocation = gl.getUniformLocation(program, "u_textureSize");
const sharpenLoc = gl.getUniformLocation(program, "u_sharpen");
const denoiseLoc = gl.getUniformLocation(program, "u_denoise");
const contrastLoc = gl.getUniformLocation(program, "u_contrast");

const positionBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,-1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

const texCoordBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,1, 0,0, 1,1, 0,0, 1,0, 1,1]), gl.STATIC_DRAW);

const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

// --- Core Logic ---

async function loadFFmpeg() {
    if (!ffmpeg) {
        ffmpeg = createFFmpeg({ log: true });
        await ffmpeg.load();
    }
}

function updateCanvasSize() {
    if(!video.videoWidth) return;
    const scaleFactor = isUpscaled ? 2 : 1;
    canvas.width = video.videoWidth * scaleFactor;
    canvas.height = video.videoHeight * scaleFactor;
    gl.viewport(0, 0, canvas.width, canvas.height);
    document.getElementById('liveRes').classList.remove('hidden');
    document.getElementById('liveResText').textContent = `${canvas.width}x${canvas.height} ${isUpscaled ? '(Upscaled)' : ''}`;
}

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const url = URL.createObjectURL(file);
        video.src = url;
        document.getElementById('fileName').textContent = file.name;
        document.getElementById('placeholder').style.display = 'none';
        video.onloadedmetadata = () => {
            sourceWidth = video.videoWidth;
            sourceHeight = video.videoHeight;
            document.getElementById('fileRes').textContent = `${sourceWidth}x${sourceHeight}`;
            isUpscaled = false; 
            updateCanvasSize();
            btnPlay.disabled = false;
            btnRecord.disabled = false;
            
            // Preload FFmpeg silently when video loads
            loadFFmpeg().catch(console.error);
        };
    }
});

function render() {
    if (video.paused || video.ended) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.useProgram(program);
    
    gl.enableVertexAttribArray(positionLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    
    gl.enableVertexAttribArray(texCoordLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(textureSizeLocation, sourceWidth, sourceHeight);
    gl.uniform1f(sharpenLoc, parseFloat(sliders.sharpen.value));
    gl.uniform1f(denoiseLoc, parseFloat(sliders.denoise.value));
    gl.uniform1f(contrastLoc, parseFloat(sliders.contrast.value));

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    animationId = requestAnimationFrame(render);
}

btnPlay.addEventListener('click', () => {
    if (video.paused) { video.play(); render(); btnPlay.innerHTML = '<i class="fas fa-pause mr-2"></i> Pause'; }
    else { video.pause(); cancelAnimationFrame(animationId); btnPlay.innerHTML = '<i class="fas fa-play mr-2"></i> Preview'; }
});

// Auto Enhance & Upscale Buttons
document.getElementById('btnAutoEnhance').addEventListener('click', () => {
    sliders.sharpen.value = 1.2; sliders.denoise.value = 0.2; sliders.contrast.value = 1.05;
    Object.keys(sliders).forEach(key => values[key].textContent = sliders[key].value);
});
document.getElementById('btnUpscale').addEventListener('click', () => {
    isUpscaled = !isUpscaled; updateCanvasSize();
    const btn = document.getElementById('btnUpscale');
    const ind = document.getElementById('upscaleIndicator');
    if(isUpscaled) { btn.classList.add('border-purple-500', 'bg-gray-600'); ind.classList.remove('hidden'); if(sliders.sharpen.value < 0.5) sliders.sharpen.value = 1.0; } 
    else { btn.classList.remove('border-purple-500', 'bg-gray-600'); ind.classList.add('hidden'); }
});
document.getElementById('btnReset').addEventListener('click', () => {
    sliders.sharpen.value = 0; sliders.denoise.value = 0; sliders.contrast.value = 1.0;
    Object.keys(sliders).forEach(key => values[key].textContent = sliders[key].value);
    if(isUpscaled) document.getElementById('btnUpscale').click();
});

// --- RECORDING & MP4 LOGIC ---

async function downloadRecording(blob, format) {
    const originalName = document.getElementById('fileName').textContent.split('.')[0];
    const filename = `${originalName}_ENHANCED_${isUpscaled ? 'Upscaled' : ''}.${format}`;

    // Case 1: If user wants WebM or MKV, or Blob is already MP4 (Native), just download
    if (format !== 'mp4' || blob.type.includes('mp4')) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        statusPanel.classList.add('hidden');
        return;
    }

    // Case 2: Convert to MP4 using FFmpeg (Fallback)
    statusText.innerHTML = '<i class="fas fa-sync fa-spin mr-2"></i> Converting to MP4...';
    conversionProgress.classList.remove('hidden');
    
    try {
        await loadFFmpeg();
        ffmpeg.FS('writeFile', 'input.webm', await fetchFile(blob));
        
        // Command: Transcode to MP4 (Fastest compatible preset)
        await ffmpeg.run('-i', 'input.webm', '-c:v', 'copy', 'output.mp4');
        
        const data = ffmpeg.FS('readFile', 'output.mp4');
        
        const mp4Blob = new Blob([data.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(mp4Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        
        // Cleanup
        ffmpeg.FS('unlink', 'input.webm');
        ffmpeg.FS('unlink', 'output.mp4');
        
    } catch (e) {
        console.error(e);
        alert("Conversion to MP4 failed. Downloading as WebM instead.");
        // Fallback download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename.replace('.mp4', '.webm');
        a.click();
    }
    
    statusPanel.classList.add('hidden');
    conversionProgress.classList.add('hidden');
}

btnRecord.addEventListener('click', () => {
    if (isRecording) {
        mediaRecorder.stop();
        btnRecord.innerHTML = '<i class="fas fa-circle mr-2"></i> Render';
        btnRecord.classList.remove('bg-red-600');
        btnRecord.classList.add('bg-gradient-to-r', 'from-pink-600', 'to-purple-600');
        isRecording = false;
        clearInterval(timerInterval);
        video.pause();
        statusText.innerHTML = '<i class="fas fa-save mr-2"></i> Saving...';
    } else {
        const fpsVal = document.getElementById('opt-fps').value;
        const formatVal = document.getElementById('opt-format').value;
        const targetFps = fpsVal === 'source' ? 30 : parseInt(fpsVal);
        const stream = canvas.captureStream(targetFps);
        recordedChunks = [];

        // Try to use native MP4 if possible, otherwise WebM
        let mimeType = 'video/webm;codecs=vp9';
        if (formatVal === 'mp4' && MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')) {
            mimeType = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
        } else if (formatVal === 'mp4' && MediaRecorder.isTypeSupported('video/mp4')) {
            mimeType = 'video/mp4';
        }

        const options = { mimeType: mimeType, videoBitsPerSecond: 8000000 };
        
        try {
            mediaRecorder = new MediaRecorder(stream, options);
        } catch (e) {
            console.warn("Native MP4 not supported, falling back to WebM for conversion.");
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        }

        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
        
        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
            downloadRecording(blob, formatVal);
        };

        mediaRecorder.start();
        video.currentTime = 0;
        video.play();
        render();

        isRecording = true;
        btnRecord.innerHTML = '<i class="fas fa-stop mr-2"></i> Stop';
        btnRecord.classList.remove('bg-gradient-to-r', 'from-pink-600', 'to-purple-600');
        btnRecord.classList.add('bg-red-600');
        
        statusPanel.classList.remove('hidden');
        statusText.innerHTML = '<i class="fas fa-circle text-red-500 mr-2"></i> Recording...';
        
        let seconds = 0;
        timerInterval = setInterval(() => {
            seconds++;
            const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
            const secs = (seconds % 60).toString().padStart(2, '0');
            statusTimer.textContent = `${mins}:${secs}`;
        }, 1000);
    }
});

Object.keys(sliders).forEach(key => {
    sliders[key].addEventListener('input', (e) => values[key].textContent = e.target.value);
});
