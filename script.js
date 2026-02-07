// --- MAIN THREAD ---
let currentMode = 'extract';
let rawGroups = []; 
let activeUrls = []; 
let worker = null;
let processingQueue = [];
let queueIndex = 0;
let looseImagesBuffer = [];

const els = {
    drop: document.getElementById('drop-zone'),
    input: document.getElementById('file-input'),
    progress: document.getElementById('progress-area'),
    bar: document.getElementById('progress-bar'),
    status: document.getElementById('status-text'),
    percent: document.getElementById('percent-text'),
    list: document.getElementById('chapter-list'),
    actionBar: document.getElementById('action-bar'),
    badge: document.getElementById('img-count-badge'),
    canvas: document.getElementById('merge-canvas'),
    settingsExtract: document.getElementById('settings-extract'),
    settingsMerge: document.getElementById('settings-merge'),
    downloadBtn: document.getElementById('download-btn'),
    addMoreBtn: document.getElementById('add-more-btn'),
    modal: document.getElementById('img-modal'),
    modalImg: document.getElementById('modal-img'),
    sizeFilter: document.getElementById('size-filter'),
    noGifs: document.getElementById('no-gifs'),
    reverse: document.getElementById('reverse-sort')
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

function init() {
    // UPDATED: Load worker from external file
    worker = new Worker('worker.js');
    worker.onmessage = handleWorkerMsg;
    loadConfig();
}

function loadConfig() {
    const saved = JSON.parse(localStorage.getItem('manga-tool-cfg') || '{}');
    if(saved.minSize) els.sizeFilter.value = saved.minSize;
    if(saved.noGifs !== undefined) els.noGifs.checked = saved.noGifs;
    if(saved.reverse !== undefined) els.reverse.checked = saved.reverse;
    if(saved.rtl !== undefined) document.getElementById('rtl-mode').checked = saved.rtl;
    if(saved.theme) document.documentElement.setAttribute('data-theme', saved.theme);
    updateSizeLabel();
}

window.saveConfig = function() {
    const cfg = {
        minSize: els.sizeFilter.value,
        noGifs: els.noGifs.checked,
        reverse: els.reverse.checked,
        rtl: document.getElementById('rtl-mode').checked,
        theme: document.documentElement.getAttribute('data-theme')
    };
    localStorage.setItem('manga-tool-cfg', JSON.stringify(cfg));
    updateSizeLabel();
};

window.triggerRefilter = function() {
    saveConfig();
    applyFiltersToAll();
    clearAndRender();
};

function updateSizeLabel() {
    document.getElementById('size-val').innerText = els.sizeFilter.value + " KB";
}

// --- FILE HANDLING ---
els.drop.onclick = () => els.input.click();
els.addMoreBtn.onclick = () => els.input.click();
els.input.onchange = () => { 
    if(els.input.files.length) handleFiles(els.input.files); 
    els.input.value = ''; 
};

els.drop.ondragover = (e) => { e.preventDefault(); els.drop.style.borderColor = 'var(--primary)'; };
els.drop.ondragleave = (e) => { e.preventDefault(); els.drop.style.borderColor = 'var(--drop-border)'; };
els.drop.ondrop = (e) => {
    e.preventDefault();
    els.drop.style.borderColor = 'var(--drop-border)';
    if(e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
};

async function handleFiles(files) {
    els.drop.style.display = 'none';
    els.progress.style.display = 'block';
    els.actionBar.style.display = 'none';
    processingQueue = Array.from(files); 
    queueIndex = 0;
    looseImagesBuffer = [];
    processNextFile();
}

async function processNextFile() {
    if (queueIndex >= processingQueue.length) {
        if (looseImagesBuffer.length > 0) {
            // For loose images, we treat them as pre-filtered candidates
            const looseCandidates = looseImagesBuffer.map((img, i) => ({
                originalIdx: i, data: img.data, ext: img.ext, size: img.data.length
            }));
            rawGroups.push({ groupName: "Loose Images " + (rawGroups.length+1), allImages: looseCandidates });
        }
        finishProcessing();
        return;
    }

    const file = processingQueue[queueIndex];
    const pct = Math.round((queueIndex / processingQueue.length) * 100);
    updateProgress(`Reading ${queueIndex + 1}/${processingQueue.length}: ${file.name}`, pct);

    const name = file.name.toLowerCase();

    if (name.endsWith('.mhtml') || name.endsWith('.mht')) {
        try {
            const buf = await file.arrayBuffer();
            worker.postMessage({ 
                type: 'extractOne', 
                buffer: buf, 
                filename: file.name
            }, [buf]); 
        } catch (err) { queueIndex++; processNextFile(); }
    } 
    else if (name.match(/\.(jpg|jpeg|png|webp)$/)) {
        try {
            const buf = await file.arrayBuffer();
            looseImagesBuffer.push({ name: file.name, data: new Uint8Array(buf), ext: name.split('.').pop() });
        } catch (e) {}
        queueIndex++;
        processNextFile(); 
    }
    else { queueIndex++; processNextFile(); }
}

function handleWorkerMsg(e) {
    const { type, text, percent, group, blob, filename } = e.data;

    if(type === 'status') {
        updateProgress(text, percent);
    }
    else if (type === 'extractDone') {
        if (group) rawGroups.push(group);
        queueIndex++;
        processNextFile();
    }
    else if (type === 'zipDone') {
        downloadBlob(blob, filename);
        els.downloadBtn.disabled = false;
        els.downloadBtn.innerText = "Download All";
        updateProgress("Complete!", 100);
        setTimeout(() => els.progress.style.display = 'none', 2000);
    }
}

function updateProgress(text, pct) {
    els.status.innerText = text;
    els.bar.style.width = pct + "%";
    els.percent.innerText = Math.round(pct) + "%";
}

function finishProcessing() {
    els.progress.style.display = 'none';
    els.actionBar.style.display = 'flex';
    applyFiltersToAll();
    clearAndRender();
}

// --- FILTERING LOGIC ---
function applyFiltersToAll() {
    const minSize = parseInt(els.sizeFilter.value) * 1024;
    const noGifs = els.noGifs.checked;
    const reverse = els.reverse.checked;

    rawGroups.forEach(group => {
        // Filter
        const valid = [];
        const filtered = [];

        group.allImages.forEach(img => {
            let reason = null;
            if (img.size < minSize) reason = `Too Small (${Math.round(img.size/1024)}KB)`;
            else if (noGifs && img.ext === 'gif') reason = "GIF Excluded";

            if (reason) {
                filtered.push({ ...img, reason });
            } else {
                valid.push(img);
            }
        });

        // Sort
        if (reverse) valid.reverse(); // Note: This reverses the original order
        
        // Renumber for display
        group.displayImages = valid.map((img, i) => ({
            ...img,
            name: `${String(i+1).padStart(3, '0')}.${img.ext}`
        }));
        
        group.filteredList = filtered;
    });
    
    updateBadge();
}

function updateBadge() {
    const totalImages = rawGroups.reduce((acc, g) => acc + g.displayImages.length, 0);
    els.badge.style.display = 'inline-block';
    els.badge.innerText = `${rawGroups.length} Files / ${totalImages} imgs`;
}

// --- RENDER LOGIC ---
function clearAndRender() {
    els.list.innerHTML = '';
    rawGroups.forEach((group, idx) => {
        const item = document.createElement('div');
        item.className = 'chapter-item';
        
        // Header
        const head = document.createElement('div');
        head.className = 'chapter-head';
        head.innerHTML = `<span>${group.groupName}</span> <span style="font-size:0.8em; color:var(--text-sub)">${group.displayImages.length} images</span>`;
        
        const removeBtn = document.createElement('span');
        removeBtn.innerHTML = " &times;";
        removeBtn.style.color = "var(--danger)";
        removeBtn.style.marginLeft = "10px";
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            rawGroups.splice(idx, 1);
            applyFiltersToAll(); // Update badge
            clearAndRender();
        };
        head.appendChild(removeBtn);

        // Body
        const body = document.createElement('div');
        body.className = 'chapter-body';

        head.onclick = () => toggleChapter(body, group);
        item.appendChild(head);
        item.appendChild(body);

        els.list.appendChild(item);
    });
}

async function toggleChapter(container, group) {
    if (container.classList.contains('expanded')) {
        container.classList.remove('expanded');
        container.innerHTML = ''; 
        return;
    }

    container.classList.add('expanded');
    container.innerHTML = '<div style="padding:10px; text-align:center">Generating previews...</div>';
    await new Promise(r => setTimeout(r, 10));

    const grid = document.createElement('div');
    grid.className = currentMode === 'extract' ? 'gallery-grid' : 'gallery-grid merge-mode';
    const isRTL = document.getElementById('rtl-mode').checked;

    const items = currentMode === 'extract' ? group.displayImages : pairImages(group.displayImages);
    const limit = Math.min(items.length, 30);

    for(let i=0; i<limit; i++) {
        let url;
        if(currentMode === 'extract') {
            const img = items[i];
            url = URL.createObjectURL(new Blob([img.data], {type: 'image/'+img.ext}));
        } else {
            url = await createMergedUrl(items[i], isRTL);
        }
        activeUrls.push(url);
        addToGrid(grid, url, currentMode !== 'extract');
    }

    if(items.length > limit) {
            const more = document.createElement('div');
            more.innerText = `+${items.length - limit} more pages`;
            more.style.gridColumn = "1/-1";
            more.style.textAlign = "center";
            more.style.padding = "10px";
            more.style.color = "var(--text-sub)";
            grid.appendChild(more);
    }

    container.innerHTML = '';
    container.appendChild(grid);

    // --- RENDER FILTERED LIST ---
    if (group.filteredList && group.filteredList.length > 0) {
        const filterSection = document.createElement('div');
        filterSection.className = 'filtered-section';
        
        const toggle = document.createElement('div');
        toggle.className = 'filtered-toggle';
        toggle.innerText = `⚠️ ${group.filteredList.length} items excluded by filters`;
        
        const list = document.createElement('div');
        list.className = 'filtered-list';
        
        // Build text list
        group.filteredList.forEach((f, idx) => {
            const r = document.createElement('div');
            r.innerText = `#${f.originalIdx} .${f.ext} - ${f.reason}`;
            list.appendChild(r);
        });

        toggle.onclick = () => {
            list.style.display = list.style.display === 'block' ? 'none' : 'block';
        };

        filterSection.appendChild(toggle);
        filterSection.appendChild(list);
        container.appendChild(filterSection);
    }
}

function pairImages(images) {
    const pairs = [];
    for(let i=0; i<images.length; i+=2) {
        pairs.push(images.slice(i, i+2)); 
    }
    return pairs;
}

async function createMergedUrl(pair, isRTL) {
    const ctx = els.canvas.getContext('2d');
    const b1 = await createImageBitmap(new Blob([pair[0].data]));
    let b2 = null;
    if(pair[1]) b2 = await createImageBitmap(new Blob([pair[1].data]));

    if(!b2) {
        els.canvas.width = b1.width;
        els.canvas.height = b1.height;
        ctx.drawImage(b1, 0, 0);
    } else {
        els.canvas.width = b1.width + b2.width;
        els.canvas.height = Math.max(b1.height, b2.height);
        ctx.fillStyle="#fff"; ctx.fillRect(0,0,els.canvas.width,els.canvas.height);

        if(isRTL) {
            ctx.drawImage(b2, 0, 0);
            ctx.drawImage(b1, b2.width, 0);
        } else {
            ctx.drawImage(b1, 0, 0);
            ctx.drawImage(b2, b1.width, 0);
        }
    }

    return new Promise(r => els.canvas.toBlob(blob => r(URL.createObjectURL(blob)), 'image/jpeg', 0.85));
}

function addToGrid(grid, url, isMerge) {
    const div = document.createElement('div');
    div.className = `gallery-item ${isMerge?'merge-item':''}`;
    div.innerHTML = `<img src="${url}" loading="lazy">`;
    div.onclick = () => openModal(url);
    grid.appendChild(div);
}

// --- DOWNLOAD LOGIC ---
els.downloadBtn.onclick = async () => {
    if(!rawGroups.length) return;

    els.downloadBtn.disabled = true;
    els.downloadBtn.innerText = "Processing...";
    els.progress.style.display = 'block';

    let finalGroups = [];
    // Use group.displayImages for download (respects filters)
    
    if(currentMode === 'merge') {
        updateProgress("Merging images for export...", 0);
        const isRTL = document.getElementById('rtl-mode').checked;

        for(let i=0; i<rawGroups.length; i++) {
            const g = rawGroups[i];
            const pairs = pairImages(g.displayImages);
            const mergedImages = [];

            for(let j=0; j<pairs.length; j++) {
                if(j%5===0) updateProgress(`Merging ${g.groupName} (${j}/${pairs.length})`, (i/rawGroups.length)*100);

                const url = await createMergedUrl(pairs[j], isRTL);
                const res = await fetch(url);
                const blob = await res.blob();
                const buf = await blob.arrayBuffer();

                mergedImages.push({
                    name: `page_${String(j).padStart(4,'0')}.jpg`,
                    data: new Uint8Array(buf),
                    ext: 'jpg'
                });
                URL.revokeObjectURL(url); 
            }
            finalGroups.push({ groupName: g.groupName, images: mergedImages });
        }
    } else {
            // Extract mode: Use the filtered 'displayImages'
            finalGroups = rawGroups.map(g => ({
                groupName: g.groupName,
                images: g.displayImages
            }));
    }

    updateProgress("Generating Archive...", 90);
    worker.postMessage({ type: 'zip', groups: finalGroups, extType: 'cbz' });
};

// --- UTILS & MODAL ---
window.setMode = (mode) => {
    currentMode = mode;
    document.querySelectorAll('.mode-tab').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${mode}`).classList.add('active');
    els.settingsExtract.classList.toggle('hidden', mode !== 'extract');
    els.settingsMerge.classList.toggle('hidden', mode === 'extract');
    clearAndRender();
};

document.getElementById('reset-btn').onclick = () => {
    activeUrls.forEach(u => URL.revokeObjectURL(u));
    location.reload();
};

document.getElementById('theme-toggle').onclick = () => {
    const html = document.documentElement;
    const newT = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', newT);
    saveConfig();
};

function openModal(src) {
    els.modalImg.src = src;
    els.modal.style.display = 'flex';
}

document.onkeydown = (e) => {
    if(els.modal.style.display === 'flex') {
        if(e.key === 'Escape') els.modal.style.display = 'none';
    }
};

function downloadBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

init();
