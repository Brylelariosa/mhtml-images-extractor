self.onmessage = function(e) {
    const { type } = e.data;
    if (type === 'extractOne') extractSingleMhtml(e.data);
    if (type === 'zip') createZip(e.data);
};

// --- HELPER: Find a byte sequence in a Uint8Array ---
function findSequence(buffer, sequence, fromIndex) {
    for (let i = fromIndex; i < buffer.length; i++) {
        if (buffer[i] === sequence[0]) {
            let match = true;
            for (let j = 1; j < sequence.length; j++) {
                if (buffer[i + j] !== sequence[j]) {
                    match = false;
                    break;
                }
            }
            if (match) return i;
        }
    }
    return -1;
}

function decodeQuotedPrintable(str) {
    return str.replace(/=[\r\n]+/g, "").replace(/=[0-9A-F]{2}/gi, function(v){
        return String.fromCharCode(parseInt(v.substr(1), 16));
    });
}

function extractSingleMhtml({ buffer, filename }) {
    try {
        const data = new Uint8Array(buffer);
        const decoder = new TextDecoder("utf-8");
        const encoder = new TextEncoder();
        let extracted = [];

        // 1. BOUNDARY DETECTION (Scan only the first 4KB to save memory)
        // We only decode the start of the file to find the boundary string.
        const headerText = decoder.decode(data.slice(0, 4096));
        let boundaryString = null;
        
        const bMatch = headerText.match(/boundary="?([^";\s]+)"?/i);
        if (bMatch) boundaryString = bMatch[1];
        else {
            const match = headerText.match(/^--[a-fA-F0-9\-]+(\r?\n|$)/m);
            if(match) boundaryString = match[0].trim().replace(/^--/, '');
        }

        if (!boundaryString) throw new Error("No boundary found");

        // Convert boundary to bytes for binary search
        const boundaryBytes = encoder.encode("--" + boundaryString);
        
        // 2. BINARY PARSING LOOP
        let currentIndex = 0;
        let partIdx = 0;

        while (currentIndex < data.length) {
            // Find start of next boundary
            const boundaryIndex = findSequence(data, boundaryBytes, currentIndex);
            if (boundaryIndex === -1) break; // No more parts

            // If we have a previous start, the data is between `currentIndex` and `boundaryIndex`
            if (currentIndex > 0) {
                // This chunk contains Headers + \r\n\r\n + Body
                const chunkStart = currentIndex;
                const chunkEnd = boundaryIndex;
                
                // Search for Header/Body separator (\r\n\r\n or \n\n) within this chunk
                // We limit header search to first 2KB of the chunk to avoid scanning the whole image
                const maxHeaderCheck = Math.min(chunkEnd, chunkStart + 2048);
                let bodyStart = -1;
                
                // Look for \r\n\r\n (13, 10, 13, 10)
                const dblCrLf = findSequence(data.subarray(chunkStart, maxHeaderCheck), new Uint8Array([13,10,13,10]), 0);
                if (dblCrLf !== -1) bodyStart = chunkStart + dblCrLf + 4;
                else {
                    // Fallback: Look for \n\n (10, 10)
                    const dblLf = findSequence(data.subarray(chunkStart, maxHeaderCheck), new Uint8Array([10,10]), 0);
                    if (dblLf !== -1) bodyStart = chunkStart + dblLf + 2;
                }

                if (bodyStart !== -1 && bodyStart < chunkEnd) {
                    // Decode Headers ONLY
                    const headers = decoder.decode(data.subarray(chunkStart, bodyStart));
                    const typeMatch = headers.match(/Content-Type:\s*image\/(jpeg|png|gif|webp)/i);
                    const encodingMatch = headers.match(/Content-Transfer-Encoding:\s*(base64|quoted-printable)/i);

                    if (typeMatch) {
                        const ext = typeMatch[1] === 'jpeg' ? 'jpg' : typeMatch[1];
                        const rawBody = data.subarray(bodyStart, chunkEnd);
                        
                        let finalBytes;

                        // Handle Encoding
                        if (encodingMatch) {
                            const enc = encodingMatch[1].toLowerCase();
                            if (enc === 'base64') {
                                // Clean newlines from base64 string then decode
                                const b64Str = decoder.decode(rawBody).replace(/[\r\n\t\s]+/g, "");
                                const bin = atob(b64Str);
                                finalBytes = new Uint8Array(bin.length);
                                for (let i = 0; i < bin.length; i++) finalBytes[i] = bin.charCodeAt(i);
                            } else if (enc === 'quoted-printable') {
                                const qpStr = decoder.decode(rawBody);
                                const clean = decodeQuotedPrintable(qpStr);
                                finalBytes = new Uint8Array(clean.length);
                                for (let i = 0; i < clean.length; i++) finalBytes[i] = clean.charCodeAt(i);
                            }
                        } 
                        
                        // If no encoding (binary), use raw bytes directly
                        if (!finalBytes) {
                             // Some MHTML saves images as raw binary. 
                             // We copy it to ensure it's a clean view.
                             finalBytes = rawBody.slice(); 
                        }

                        if (finalBytes && finalBytes.length > 100) {
                             extracted.push({ 
                                 sortKey: String(partIdx).padStart(8, '0'), 
                                 data: finalBytes, 
                                 ext, 
                                 size: finalBytes.length 
                             });
                        }
                    }
                }
            }
            
            partIdx++;
            // Move index past the current boundary
            currentIndex = boundaryIndex + boundaryBytes.length;
        }

        extracted.sort((a,b) => a.sortKey.localeCompare(b.sortKey, undefined, {numeric:true}));

        const finalImages = extracted.map((item, i) => ({ 
            originalIdx: i,
            data: item.data, 
            ext: item.ext, 
            size: item.size 
        }));

        // --- 3. SMART RENAME LOGIC ---
        let baseName = filename.replace(/\.mhtml?/i, "");
        baseName = baseName.replace(/_/g, " "); 
        baseName = baseName.replace(/\+/g, " "); 
        baseName = baseName.replace(/\[.*?\]|\(.*?\)/g, ""); 
        baseName = baseName.replace(/\b(read manga online|read online|manga)\b/gi, ""); 
        baseName = baseName.replace(/\s+/g, " ").trim(); 

        const nameMatch = baseName.match(/^(.*?)(\b(?:chapter|ch\.?|no\.?|c\.?|vol\.?|volume|#)\s*[\d\.]+|\b\d+)(.*)$/i);
        
        if (nameMatch) {
            const prefix = nameMatch[1].trim();
            const numberPart = nameMatch[2].trim();
            const suffix = nameMatch[3].trim();
            const cleanPrefix = prefix.replace(/[-_]$/, "").trim();
            
            if(cleanPrefix) {
                baseName = `${numberPart} - ${cleanPrefix} ${suffix}`.trim();
            } else {
                baseName = `${numberPart} ${suffix}`.trim();
            }
        }

        baseName = baseName.replace(/\s+-\s*$/, "").replace(/\s+/g, " ").trim();

        const group = finalImages.length > 0 ? { groupName: baseName, allImages: finalImages } : null;
        self.postMessage({ type: 'extractDone', group: group });
        
    } catch(e) {
        console.error(e);
        self.postMessage({ type: 'status', text: "Error parsing file", percent: 0 });
    }
}

// 4. ASYNC ZIP CREATION
async function createZip({ groups, extType }) {
    try {
        const crcTable = new Int32Array(256);
        for(let i=0; i<256; i++){let c=i; for(let k=0; k<8; k++) c=((c&1)?(0xEDB88320^(c>>>1)):(c>>>1)); crcTable[i]=c;}
        const crc32 = d => {let c=-1; for(let i=0;i<d.length;i++) c=(c>>>8)^crcTable[(c^d[i])&0xFF]; return (c^-1)>>>0;};

        const parts = [], cd = []; 
        let offset = 0; 
        const enc = new TextEncoder();

        let totalFiles = 0;
        groups.forEach(g => totalFiles += g.images.length);
        let processed = 0;

        if (totalFiles === 0) throw new Error("No images to zip");

        for(const group of groups) {
            const cleanGroupName = group.groupName.replace(/[\\/:*?"<>|]/g, "_");
            const folderName = cleanGroupName + "/";

            for(const img of group.images) {
                processed++;

                if(processed % 20 === 0) {
                     self.postMessage({ type: 'status', text: "Compressing...", percent: (processed/totalFiles)*100 });
                     await new Promise(r => setTimeout(r, 5)); 
                }

                const path = folderName + img.name;
                const n = enc.encode(path); 
                const cr = crc32(img.data);

                const h = new Uint8Array(30+n.length); const v=new DataView(h.buffer);
                v.setUint32(0,0x04034b50,true); v.setUint16(4,10,true); v.setUint16(6,0,true); v.setUint16(8,0,true);
                v.setUint32(14,cr,true); v.setUint32(18,img.data.length,true); v.setUint32(22,img.data.length,true);
                v.setUint16(26,n.length,true); v.setUint16(28,0,true); h.set(n,30); 

                parts.push(h); parts.push(img.data);

                const c = new Uint8Array(46+n.length); const cv=new DataView(c.buffer);
                cv.setUint32(0,0x02014b50,true); cv.setUint16(4,10,true); cv.setUint16(6,10,true);
                cv.setUint16(8,0,true); cv.setUint16(10,0,true); cv.setUint32(16,cr,true);
                cv.setUint32(20,img.data.length,true); cv.setUint32(24,img.data.length,true);
                cv.setUint16(28,n.length,true); cv.setUint16(30,0,true); cv.setUint16(32,0,true);
                cv.setUint32(42,offset,true); c.set(n,46); 

                cd.push(c); offset += h.length + img.data.length;
            }
        }

        const cdLen = cd.reduce((a,c)=>a+c.length,0);
        const eocd = new Uint8Array(22); const ev=new DataView(eocd.buffer);
        ev.setUint32(0,0x06054b50,true); ev.setUint16(8,processed,true);
        ev.setUint16(10,processed,true); ev.setUint32(12,cdLen,true); ev.setUint32(16,offset,true);

        const blob = new Blob([...parts, ...cd, eocd], {type: 'application/zip'});
        self.postMessage({ type: 'zipDone', blob, filename: `Manga_Batch.${extType}` });

    } catch(err) {
        self.postMessage({ type: 'error', text: err.message });
    }
                            }
