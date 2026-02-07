self.onmessage = function(e) {
    const { type } = e.data;
    if (type === 'extractOne') extractSingleMhtml(e.data);
    if (type === 'zip') createZip(e.data);
};

function decodeQuotedPrintable(str) {
    return str.replace(/=[\r\n]+/g, "").replace(/=[0-9A-F]{2}/gi, function(v){
        return String.fromCharCode(parseInt(v.substr(1), 16));
    });
}

function extractSingleMhtml({ buffer, filename }) {
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(buffer);
    let extracted = [];

    let boundary = null;
    const bMatch = content.match(/boundary="?([^";\s]+)"?/i);
    if (bMatch) boundary = bMatch[1];
    else {
        const match = content.match(/^--[a-fA-F0-9\-]+(\r?\n|$)/m);
        if(match) boundary = match[0].trim().replace(/^--/, '');
    }

    if (boundary) {
        const parts = content.split("--" + boundary);
        
        parts.forEach((part, idx) => {
            const sep = part.indexOf("\r\n\r\n");
            let bodyStart = sep, sepLen = 4;
            if(sep === -1) {
                const sep2 = part.indexOf("\n\n");
                if(sep2 !== -1) { bodyStart = sep2; sepLen = 2; } else return;
            }

            const headers = part.substring(0, bodyStart);
            let cleanBody = part.substring(bodyStart + sepLen).replace(/[\r\n]+$/, ""); 

            // Minimal filter to avoid total garbage (0 bytes)
            if (cleanBody.length < 10) return;

            const typeMatch = headers.match(/Content-Type:\s*image\/(jpeg|png|gif|webp)/i);
            const encodingMatch = headers.match(/Content-Transfer-Encoding:\s*(base64|quoted-printable)/i);

            const sortKey = String(idx).padStart(8, '0');

            if (typeMatch) {
                const ext = typeMatch[1] === 'jpeg' ? 'jpg' : typeMatch[1];
                try {
                    let bytes;
                    if (encodingMatch && encodingMatch[1].toLowerCase() === 'quoted-printable') {
                        cleanBody = decodeQuotedPrintable(cleanBody);
                        const bin = cleanBody.split('').map(c => c.charCodeAt(0));
                        bytes = new Uint8Array(bin);
                    } else {
                        const bin = atob(cleanBody.replace(/[\r\n\t\s]+/g, ""));
                        if (bin.length < 10) return; 
                        bytes = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    }
                    
                    // We extract ALL images here. Filtering happens on UI now.
                    extracted.push({ sortKey, data: bytes, ext, size: bytes.length });

                } catch (err) { /* Skip corrupt parts */ }
            }
        });
    }

    // Just sort by file order initially
    extracted.sort((a,b) => a.sortKey.localeCompare(b.sortKey, undefined, {numeric:true}));

    const finalImages = extracted.map((item, i) => {
        return { 
            originalIdx: i,
            data: item.data, 
            ext: item.ext, 
            size: item.size 
        };
    });

    // Smart Rename
    let baseName = filename.replace(/\.mhtml?/i, "");
    const nameMatch = baseName.match(/^(.*?)(\b(?:chapter|ch\.?|vol\.?|volume)\s*[\d\.]+)(.*)$/i);
    if (nameMatch) {
        baseName = `${nameMatch[2].trim()} ${nameMatch[1].trim()} ${nameMatch[3].trim()}`.replace(/\s+/g, ' ').trim();
    }

    const group = finalImages.length > 0 ? { groupName: baseName, allImages: finalImages } : null;
    self.postMessage({ type: 'extractDone', group: group });
}

function createZip({ groups, extType }) {
    const crcTable = new Int32Array(256);
    for(let i=0; i<256; i++){let c=i; for(let k=0; k<8; k++) c=((c&1)?(0xEDB88320^(c>>>1)):(c>>>1)); crcTable[i]=c;}
    const crc32 = d => {let c=-1; for(let i=0;i<d.length;i++) c=(c>>>8)^crcTable[(c^d[i])&0xFF]; return (c^-1)>>>0;};

    const parts = [], cd = []; 
    let offset = 0; 
    const enc = new TextEncoder();

    let totalFiles = 0;
    groups.forEach(g => totalFiles += g.images.length);
    let processed = 0;

    for(const group of groups) {
        const cleanGroupName = group.groupName.replace(/[\\/:*?"<>|]/g, "_");
        const folderName = cleanGroupName + "/";

        for(const img of group.images) {
            processed++;
            if(processed % 10 === 0) {
                 self.postMessage({ type: 'status', text: "Compressing...", percent: (processed/totalFiles)*100 });
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
                                     }
      
