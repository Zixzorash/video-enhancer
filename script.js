// --- Variables ---
const video = document.getElementById('sourceVideo');
const canvas = document.getElementById('glCanvas');
// Note: alpha: false helps performance and might fix black screen issues
const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: false }); 
const fileInput = document.getElementById('videoUpload');
const btnPlay = document.getElementById('btnPlay');
const btnRecord = document.getElementById('btnRecord');

// UI Elements for Status
const placeholder = document.getElementById('placeholder');
const statusPanel = document.getElementById('statusPanel');
const statusText = document.getElementById('statusText');
const statusTimer = document.getElementById('statusTimer');
const conversionProgress = document.getElementById('conversionProgress');
const fileInfo = document.getElementById('fileInfo');

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

// --- WebGL Shaders ---
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
        
        // Simple Box Blur for Denoise
        vec4 colorL = texture2D(u_image, v_texCoord + vec2(-onePixel.x, 0));
        vec4 colorR = texture2D(u_image, v_texCoord + vec2(onePixel.x, 0));
        vec4 colorU = texture2D(u_image, v_texCoord + vec2(0, -onePixel.y));
        vec4 colorD = texture2D(u_image, v_texCoord + vec2(0, onePixel.y));
        vec4 blur = (color + colorL + colorR + colorU + colorD) / 5.0;
        vec4 denoisedColor = mix(color, blur, u_denoise);

        // Laplacian Sharpen
        vec4 edge = texture2D(u_image, v_texCoord + vec2(0, -onePixel.y)) +
                    texture2D(u_image, v_texCoord + vec2(-onePixel.x, 0)) +
                    texture2D(u_image, v_texCoord + vec2(onePixel.x, 0)) +
                    texture2D(u_image, v_texCoord + vec2(0, onePixel.y));
        
        vec4 sharpened = denoisedColor + (denoisedColor * 4.0 - edge) * u_sharpen;
        
        // Contrast
        vec3 finalColor = (sharpened.rgb - 0.5) * u_contrast + 0.5;
        
        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

// --- Init WebGL ---
function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Shader Error:", gl.getShaderInfoLog(shader));
        return null;
    }
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

// --- FILE LOADING LOGIC (FIXED) ---

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
    
    // Draw initial frame
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.useProgram(program);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    
    document.getElementById('liveRes').classList.remove('hidden');
    document.getElementById('liveResText').textContent = `${canvas.width}x${canvas.height} ${isUpscaled ? '(Upscaled)' : ''}`;
}

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        // 1. Show Loading State immediately
        placeholder.innerHTML = '<div class="text-pink-500"><i class="fas fa-spinner fa-spin text-3xl mb-2"></i><p>Loading Video...</p></div>';
        
        // 2. Check Extension Warning
        const ext = file.name.split('.').pop().toLowerCase();
        if(['mkv', 'avi', 'ts'].includes(ext)) {
            alert(`Warning: Browsers usually cannot play .${ext.toUpperCase()} files directly.\n\nIf the video does not load, please convert it to MP4 first or try a different file.`);
        }

        // 3. Load Video
        const url = URL.createObjectURL(file);
        video.src = url;
        video.load(); // Force load
        
        // Update UI Info
        fileInfo.classList.remove('hidden');
        document.getElementById('fileName').textContent = file.name;

        // 4. Success Handler
        video.onloadedmetadata = () => {
            placeholder.style.display = 'none'; // Hide placeholder
            sourceWidth = video.videoWidth;
            sourceHeight = video.videoHeight;
            document.getElementById('fileRes').textContent = `${sourceWidth}x${sourceHeight}`;
            
            isUpscaled = false; 
            updateCanvasSize();
            
            btnPlay.disabled = false;
            btnRecord.disabled = false;
            
            // Try preloading FFmpeg
            loadFFmpeg().catch(err => console.log("FFmpeg preload optional error:", err));
        };

        // 5. Error Handler (Crucial for AVI/MKV)
        video.onerror = () => {
            placeholder.innerHTML = `
                <div class="text-red-500 text-center">
                    <i class="fas fa-exclamation-triangle text-4xl mb-2"></i>
                    <p class="font-bold">Format Not Supported</p>
                    <p class="text-sm text-gray-400 mt-2">Browser cannot decode this file.</p>
                    <p class="text-xs text-gray-500">Try using .MP4 or .WebM</p>
                </div>
            `;
            alert("Error: This video format is not supported by your browser.\nPlease use MP4 or WebM files.");
        };
    }
});

function render() {
    if (video.paused || video.ended) return;
    
    // Update Texture
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    
    // Draw
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
    if(!video.src) return;
    if (video.paused) { 
        video.play(); 
        render(); 
        btnPlay.innerHTML = '<i class="fas fa-pause mr-2"></i> Pause'; 
        btnPlay.classList.add('bg-pink-600');
    } else { 
        video.pause(); 
        cancelAnimationFrame(animationId); 
        btnPlay.innerHTML = '<i class="fas fa-play mr-2"></i> Preview'; 
        btnPlay.classList.remove('bg-pink-600');
    }
});

// Auto Enhance
document.getElementById('btnAutoEnhance').addEventListener('click', () => {
    if(!video.src) return;
    sliders.sharpen.value = 1.2; 
    sliders.denoise.value = 0.2; 
    sliders.contrast.value = 1.05;
    Object.keys(sliders).forEach(key => values[key].textContent = sliders[key].value);
    // Render one frame to show changes if paused
    if(video.paused) requestAnimationFrame(() => {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    });
});

// Upscale
document.getElementById('btnUpscale').addEventListener('click', () => {
    if(!video.src) return;
    isUpscaled = !isUpscaled; 
    updateCanvasSize();
    const btn = document.getElementById('btnUpscale');
    const ind = document.getElementById('upscaleIndicator');
    if(isUpscaled) { 
        btn.classList.add('border-purple-500', 'bg-gray-600'); 
        ind.classList.remove('hidden'); 
        if(parseFloat(sliders.sharpen.value) < 0.5) {
            sliders.sharpen.value = 1.0; 
            values.sharpen.textContent = "1.0";
        }
    } else { 
        btn.classList.remove('border-purple-500', 'bg-gray-600'); 
        ind.classList.add('hidden'); 
    }
    // Re-render immediate frame
    if(video.paused) requestAnimationFrame(() => {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    });
});

// Reset
document.getElementById('btnReset').addEventListener('click', () => {
    sliders.sharpen.value = 0; sliders.denoise.value = 0; sliders.contrast.value = 1.0;
    Object.keys(sliders).forEach(key => values[key].textContent = sliders[key].value);
    if(isUpscaled) document.getElementById('btnUpscale').click();
    if(video.paused && video.src) requestAnimationFrame(() => {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    });
});

// --- RECORDING ---

async function downloadRecording(blob, format) {
    const originalName = document.getElementById('fileName').textContent.split('.')[0] || 'video';
    const filename = `${originalName}_ENHANCED_${isUpscaled ? 'Upscaled' : ''}.${format}`;

    if (format !== 'mp4' || blob.type.includes('mp4')) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        statusPanel.classList.add('hidden');
        return;
    }

    // Convert to MP4
    statusText.innerHTML = '<i class="fas fa-sync fa-spin mr-2"></i> Converting to MP4...';
    conversionProgress.classList.remove('hidden');
    conversionBar.style.width = '50%';
    
    try {
        await loadFFmpeg();
        ffmpeg.FS('writeFile', 'input.webm', await fetchFile(blob));
        await ffmpeg.run('-i', 'input.webm', '-c:v', 'copy', 'output.mp4');
        const data = ffmpeg.FS('readFile', 'output.mp4');
        
        conversionBar.style.width = '100%';
        const mp4Blob = new Blob([data.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(mp4Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        
        ffmpeg.FS('unlink', 'input.webm');
        ffmpeg.FS('unlink', 'output.mp4');
    } catch (e) {
        console.error(e);
        alert("Conversion failed. Downloading WebM.");
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename.replace('.mp4', '.webm');
        a.click();
    }
    statusPanel.classList.add('hidden');
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
        if(!video.src) return;
        const fpsVal = document.getElementById('opt-fps').value;
        const formatVal = document.getElementById('opt-format').value;
        const targetFps = fpsVal === 'source' ? 30 : parseInt(fpsVal);
        const stream = canvas.captureStream(targetFps);
        recordedChunks = [];

        let mimeType = 'video/webm;codecs=vp9';
        if (formatVal === 'mp4' && MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')) {
            mimeType = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
        } else if (formatVal === 'mp4' && MediaRecorder.isTypeSupported('video/mp4')) {
            mimeType = 'video/mp4';
        }

        try {
            mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType, videoBitsPerSecond: 8000000 });
        } catch (e) {
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
        statusTimer.textContent = "00:00";
        timerInterval = setInterval(() => {
            seconds++;
            const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
            const secs = (seconds % 60).toString().padStart(2, '0');
            statusTimer.textContent = `${mins}:${secs}`;
        }, 1000);
    }
});

Object.keys(sliders).forEach(key => {
    sliders[key].addEventListener('input', (e) => {
        values[key].textContent = e.target.value;
        // If paused, render once to show slider change
        if(video.paused && video.src) requestAnimationFrame(() => {
            gl.useProgram(program);
            gl.uniform1f(sharpenLoc, parseFloat(sliders.sharpen.value));
            gl.uniform1f(denoiseLoc, parseFloat(sliders.denoise.value));
            gl.uniform1f(contrastLoc, parseFloat(sliders.contrast.value));
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        });
    });
});
