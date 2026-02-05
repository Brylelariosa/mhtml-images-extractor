importScripts('fflate.min.js');

self.onmessage = function(e) {
    const { type } = e.data;
    if (type === 'extractOne') extractMhtmlBinary(e.data); // New Binary Parser
    if (type === 'zip') createZipFflate(e.data);           // New fflate zipper
};

// --- 1. MEMORY-SAFE BINARY MHTML PARSER ---
function extractMhtmlBinary({ file, fileId }) {
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const buffer = new Uint8Array(e.target.result);
            processBuffer(buffer, file, fileId);
        } catch (err) {
            postError(fileId, "Memory Error: " + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

function processBuffer(buffer, file, fileId) {
    // 1. Decode just the start to find the boundary
    const headerChunk = new TextDecoder().decode(buffer.subarray(0, 4096));
    const boundaryMatch = headerChunk.match(/boundary="?([^";\s]+)"?/i) || headerChunk.match(/boundary=([^\s]+)/i);

    if (!boundaryMatch) {
        postError(fileId, "No boundary found in header.");
        return;
    }

    const boundaryStr = "--" + boundaryMatch[1];
    const boundaryBytes = new TextEncoder().encode(boundaryStr);
    
    // 2. Find all occurrences of the boundary in the raw binary
    const indices = findSequence(buffer, boundaryBytes);
    
    const images = [];
    
    // 3. Process each chunk
    for (let i = 0; i < indices.length - 1; i++) {
        const start = indices[i] + boundaryBytes.length;
        const end = indices[i+1];
        
        // Isolate this part
        const part = buffer.subarray(start, end);
        
        // Find the double newline \r\n\r\n that separates headers from body
        const splitIdx = findHeaderEnd(part);
        
        if (splitIdx !== -1) {
            // Decode headers only (safe & fast)
            const headers = new TextDecoder().decode(part.subarray(0, splitIdx));
            
            // Check if it's an image
            if (headers.includes('Content-Type: image/') || headers.includes('Content-Location:')) {
                // Extract filename
                let name = "image.jpg";
                const nameMatch = headers.match(/Content-Location:\s*([^\s\r\n]+)/i);
                if (nameMatch) name = nameMatch[1].split('/').pop();
                
                // Extract clean binary body (skip the \r\n\r\n)
                const body = part.subarray(splitIdx + 4); 
                
                if (body.length > 0) {
                    images.push({ name: decodeURIComponent(name), data: body });
                }
            }
        }
    }

    self.postMessage({ 
        type: 'done', 
        fileId: fileId, 
        groupName: file.name.replace(/\.mhtml$/i, '').replace(/\.mht$/i, ''),
        images: images.sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric: true})) 
    });
}

// Helper: Naive binary search (Boyer-Moore is faster but this is fine for client-side)
function findSequence(buffer, sequence) {
    const indices = [];
    for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === sequence[0]) {
            let match = true;
            for (let j = 1; j < sequence.length; j++) {
                if (buffer[i + j] !== sequence[j]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                indices.push(i);
                i += sequence.length - 1;
            }
        }
    }
    return indices;
}

// Helper: Find \r\n\r\n (13, 10, 13, 10)
function findHeaderEnd(buffer) {
    for(let i=0; i<Math.min(buffer.length, 2000); i++) { // Limit search to header area
        if (buffer[i] === 13 && buffer[i+1] === 10 && buffer[i+2] === 13 && buffer[i+3] === 10) {
            return i;
        }
    }
    return -1;
}

function postError(id, msg) {
    self.postMessage({ type: 'error', fileId: id, message: msg });
}

// --- 2. FAST ZIP WITH FFLATE ---
function createZipFflate({ groups }) {
    const zipData = {};
    
    groups.forEach(group => {
        const folder = (group.groupName || "Untitled").trim().replace(/[\/\\]/g, "_");
        
        group.images.forEach(img => {
            // fflate structure: "Folder/File.jpg" : Uint8Array
            zipData[`${folder}/${img.name}`] = img.data;
        });
    });

    // Level 0 = Store (Fastest), Level 6 = Default Deflate
    fflate.zip(zipData, { level: 0 }, (err, data) => {
        if (err) {
            self.postMessage({ type: 'status', text: "Zip Error", percent: 0 });
            return;
        }
        const blob = new Blob([data], { type: 'application/zip' });
        self.postMessage({ type: 'zipDone', blob, filename: "Manga_Batch.zip" });
    });
}