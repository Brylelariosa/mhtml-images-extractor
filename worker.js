importScripts('fflate.min.js');

self.onmessage = function(e) {
    const { type } = e.data;
    if (type === 'extract') extractMhtmlBinary(e.data);
    if (type === 'zip') createZipFflate(e.data);
};

// --- 1. CRASH-PROOF BINARY EXTRACTOR ---
function extractMhtmlBinary({ file, fileId }) {
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const buffer = new Uint8Array(e.target.result);
            processBuffer(buffer, file, fileId);
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message });
        }
    };
    reader.readAsArrayBuffer(file);
}

function processBuffer(buffer, file, fileId) {
    // 1. Find Boundary (Search in first 4KB only)
    const headerStr = new TextDecoder().decode(buffer.subarray(0, 4096));
    const boundaryMatch = headerStr.match(/boundary="?([^";\s]+)"?/i) || headerStr.match(/boundary=([^\s]+)/i);

    if (!boundaryMatch) {
        // Fallback for non-MHTML or bad headers
        self.postMessage({ type: 'error', message: "No MHTML boundary found." });
        return;
    }

    const boundary = "--" + boundaryMatch[1];
    const boundaryBytes = new TextEncoder().encode(boundary);
    const indices = findSequence(buffer, boundaryBytes);
    const images = [];

    // 2. Extract Images
    for (let i = 0; i < indices.length - 1; i++) {
        const start = indices[i] + boundaryBytes.length;
        const end = indices[i+1];
        const part = buffer.subarray(start, end);
        
        // Find \r\n\r\n separator
        const splitIdx = findHeaderEnd(part);
        if (splitIdx !== -1) {
            const head = new TextDecoder().decode(part.subarray(0, splitIdx));
            
            // Check for images
            if (head.includes('Content-Type: image/') || head.includes('Content-Location:')) {
                let name = "image.jpg";
                const nameMatch = head.match(/Content-Location:\s*([^\s\r\n]+)/i);
                if (nameMatch) name = nameMatch[1].split('/').pop();
                
                // Get binary data (skip headers)
                const data = part.subarray(splitIdx + 4); 
                if(data.length > 0) {
                    images.push({ name: decodeURIComponent(name), data: data });
                }
            }
        }
    }
    
    // 3. Send back
    self.postMessage({ 
        type: 'done', 
        fileId: fileId,
        groupName: file.name.replace(/\.mhtml$/i, '').replace(/\.mht$/i, ''),
        images: images.sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric: true})) 
    });
}

// Helper: Fast Binary Search
function findSequence(buff, seq) {
    const idxs = [];
    for (let i = 0; i < buff.length; i++) {
        if (buff[i] === seq[0]) {
            let m = true;
            for (let j = 1; j < seq.length; j++) {
                if (buff[i+j] !== seq[j]) { m = false; break; }
            }
            if (m) { idxs.push(i); i += seq.length - 1; }
        }
    }
    return idxs;
}

function findHeaderEnd(buff) {
    for(let i=0; i<Math.min(buff.length, 2000); i++) {
        if (buff[i]===13 && buff[i+1]===10 && buff[i+2]===13 && buff[i+3]===10) return i;
    }
    return -1;
}

// --- 2. FAST ZIPPER ---
function createZipFflate({ groups }) {
    const zipData = {};
    groups.forEach(g => {
        const folder = (g.groupName || "Untitled").trim().replace(/[\/\\]/g, "_");
        g.images.forEach(img => {
            zipData[`${folder}/${img.name}`] = img.data;
        });
    });

    fflate.zip(zipData, { level: 0 }, (err, data) => {
        if(err) { self.postMessage({ type: 'error', message: "Zip Failed" }); return; }
        const blob = new Blob([data], { type: 'application/zip' });
        self.postMessage({ type: 'zipDone', blob: blob, name: "Manga_Batch.zip" });
    });
}
