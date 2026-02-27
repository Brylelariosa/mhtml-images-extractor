// --- MAIN THREAD ---
let currentMode = 'extract';
let rawGroups = []; 
let activeUrls = []; 
let worker = null;
let processingQueue = [];
let queueIndex = 0;
let looseImagesBuffer = [];
let dataTransferred = false;
let corruptCount = 0; 

// Modal State
let currentModalImage = null; 
let currentModalGroup = null;
let currentModalList = []; 
let currentModalIndex = -1; 

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
    
    // Modal
    modal: document.getElementById('img-modal'),
    modalImg: document.getElementById('modal-img'),
    modalActions: document.getElementById('modal-actions'),
    modalReason: document.getElementById('modal-reason'),
    modalRestoreBtn: document.getElementById('modal-restore-btn'),
    modalDeleteBtn: document.getElementById('modal-delete-btn'),

    // Settings
    sizeFilter: document.getElementById('size-filter'),
    noGifs: document.getElementById('no-gifs'),
    reverse: document.getElementById('reverse-sort')
};

// Register Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(reg => {
            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        console.log("New update available!");
                    }
                });
            });
        })
        .catch(err => console.error("SW Fail:", err));
}

function init() {
    try {
        worker = new Worker('worker.js');
        worker.onmessage = handleWorkerMsg;
        worker.onerror = (e) => {
            const msg = e.message ? e.message : "File not found (Offline missing file?)";
            alert("Worker Failed: " + msg + "\n\nTry clearing browser cache for this site.");
            els.downloadBtn.disabled = false;
            els.progress.style.display = 'none';
        };
    } catch (err) {
        alert("Could not start worker: " + err.message);
    }
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
    if(dataTransferred) return;
    saveConfig();
    applyFiltersToAll();
    clearAndRender();
};

function updateSizeLabel() {
    document.getElementById('size-val').innerText = els.sizeFilter.value + " KB";
}

// --- FILE HANDLING ---
els.drop.onclick = () => els.input.click();
els.addMoreBtn.onclick = () => { if(!dataTransferred) els.input.click(); };
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
    if(dataTransferred) {
        if(confirm("Downloading cleared the memory. Reload to process new files?")) location.reload();
        return;
    }
    resetCorruptState();
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
            worker.postMessage({ type: 'extractOne', buffer: buf, filename: file.name }, [buf]); 
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
    else if(type === 'error') {
        alert("Worker Error: " + text);
        els.downloadBtn.disabled = false;
        els.downloadBtn.innerText = "Download All";
        els.progress.style.display = 'none';
    }
    else if (type === 'extractDone') {
        if (group) rawGroups.push(group);
        queueIndex++;
        processNextFile();
    }
    else if (type === 'zipDone') {
        downloadBlob(blob, filename);
        els.downloadBtn.disabled = true;
        els.downloadBtn.innerText = "Complete! (Reload to start over)";
        updateProgress("Download Ready", 100);
        dataTransferred = true;
        document.querySelectorAll('.chapter-item').forEach(el => el.style.opacity = '0.5');
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
        const valid = [];
        const filtered = [];

        group.allImages.forEach(img => {
            let reason = null;
            if (img.userDeleted) {
                reason = "Manually Deleted";
            } else if (img.forceKeep) {
                reason = null; 
            } else {
                if (img.size < minSize) reason = `Too Small (${Math.round(img.size/1024)}KB)`;
                else if (noGifs && img.ext.toLowerCase() === 'gif') reason = "GIF Excluded";
            }

            if (reason) {
                filtered.push({ ...img, reason });
            } else {
                valid.push(img);
            }
        });

        if (reverse) valid.reverse();
        
        group.displayImages = valid.map((img, i) => ({
            ...img,
            name: `${String(i+1).padStart(3, '0')}.${img.ext}`
        }));
        
        group.filteredList = filtered;
    });
    updateBadge();
}

// --- TOTAL SIZE INDICATOR ---
function updateBadge() {
    let totalImages = 0;
    let totalSize = 0;

    rawGroups.forEach(g => {
        totalImages += g.displayImages.length;
        g.displayImages.forEach(img => totalSize += img.size);
    });

    els.badge.style.display = 'inline-block';
    els.badge.innerText = `${rawGroups.length} Files / ${totalImages} imgs`;

    if (!els.downloadBtn.disabled && !dataTransferred) {
        const sizeStr = formatBytes(totalSize);
        els.downloadBtn.innerText = `Download All (~${sizeStr})`;
    }
}

function formatBytes(bytes, decimals = 1) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// --- RENDER LOGIC ---
function clearAndRender() {
    // 1. Remember which chapters are currently open
    const expandedIndices = new Set();
    const currentItems = els.list.querySelectorAll('.chapter-item');
    currentItems.forEach((item, idx) => {
        const body = item.querySelector('.chapter-body');
        if (body && body.classList.contains('expanded')) {
            expandedIndices.add(idx);
        }
    });

    els.list.innerHTML = '';
    rawGroups.forEach((group, idx) => {
        const item = document.createElement('div');
        item.className = 'chapter-item';
        
        const head = document.createElement('div');
        head.className = 'chapter-head';
        head.innerHTML = `<span>${group.groupName}</span> <span style="font-size:0.8em; color:var(--text-sub)">${group.displayImages.length} images</span>`;
        
        const removeBtn = document.createElement('span');
        removeBtn.innerHTML = " &times;";
        removeBtn.style.color = "var(--danger)";
        removeBtn.style.marginLeft = "10px";
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            if(dataTransferred) return;
            rawGroups.splice(idx, 1);
            applyFiltersToAll(); 
            clearAndRender();
        };
        head.appendChild(removeBtn);

        const body = document.createElement('div');
        body.className = 'chapter-body';

        head.onclick = () => toggleChapter(body, group);
        item.appendChild(head);
        item.appendChild(body);

        els.list.appendChild(item);

        // 2. Automatically reopen the chapter if it was open before
        if (expandedIndices.has(idx)) {
            toggleChapter(body, group);
        }
    });
}

async function toggleChapter(container, group) {
    if (dataTransferred) return;

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
    const limit = Math.min(items.length, 40);

    // Initial Load
    for(let i=0; i<limit; i++) {
        let url;
        let context = null;
        if(currentMode === 'extract') {
            const img = items[i];
            url = URL.createObjectURL(new Blob([img.data], {type: 'image/'+img.ext}));
            context = { imgObject: group.allImages[img.originalIdx], group: group, isNormal: true };
        } else {
            url = await createMergedUrl(items[i], isRTL);
        }
        activeUrls.push(url);
        addToGrid(grid, url, currentMode !== 'extract', context);
    }

    // Load More Button Logic
    if(items.length > limit) {
        const moreContainer = document.createElement('div');
        moreContainer.style.gridColumn = "1/-1";
        moreContainer.style.textAlign = "center";
        moreContainer.style.padding = "20px";

        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = "btn btn-secondary"; 
        loadMoreBtn.innerText = `Load remaining ${items.length - limit} pages`;
        loadMoreBtn.style.width = "auto";
        
        loadMoreBtn.onclick = async () => {
            loadMoreBtn.innerText = "Loading...";
            loadMoreBtn.disabled = true;
            
            // Give UI time to update text
            await new Promise(r => setTimeout(r, 50));

            for(let i=limit; i<items.length; i++) {
                let url;
                let context = null;
                if(currentMode === 'extract') {
                    const img = items[i];
                    url = URL.createObjectURL(new Blob([img.data], {type: 'image/'+img.ext}));
                    context = { imgObject: group.allImages[img.originalIdx], group: group, isNormal: true };
                } else {
                    url = await createMergedUrl(items[i], isRTL);
                }
                activeUrls.push(url);
                addToGrid(grid, url, currentMode !== 'extract', context);
            }
            moreContainer.remove(); // Remove button after loading
        };

        moreContainer.appendChild(loadMoreBtn);
        grid.appendChild(moreContainer);
    }

    container.innerHTML = '';
    container.appendChild(grid);

    // Filtered List Logic
    if (group.filteredList && group.filteredList.length > 0) {
        const filterSection = document.createElement('div');
        filterSection.className = 'filtered-section';
        
        const toggle = document.createElement('div');
        toggle.className = 'filtered-toggle';
        toggle.innerText = `⚠️ Show ${group.filteredList.length} filtered images`;
        
        const listGrid = document.createElement('div');
        listGrid.className = 'filtered-grid';
        listGrid.style.display = 'none';

        group.filteredList.forEach((f) => {
            const url = URL.createObjectURL(new Blob([f.data], {type: 'image/'+f.ext}));
            activeUrls.push(url);
            const div = document.createElement('div');
            div.className = 'filtered-item';
            div.innerHTML = `<img src="${url}" loading="lazy"><div class="filter-reason">${f.reason}</div>`;
            div.onclick = () => openModal(url, { imgObject: group.allImages[f.originalIdx], reason: f.reason, group: group, isNormal: false }, listGrid);
            div.title = "Click to View & Restore";
            listGrid.appendChild(div);
        });

        toggle.onclick = () => {
            const isHidden = listGrid.style.display === 'none';
            listGrid.style.display = isHidden ? 'grid' : 'none';
            toggle.innerText = isHidden ? `⚠️ Hide ${group.filteredList.length} filtered images` : `⚠️ Show ${group.filteredList.length} filtered images`;
        };

        filterSection.appendChild(toggle);
        filterSection.appendChild(listGrid);
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

// --- SAFE BITMAP GENERATOR (Error Handling) ---
async function safeGetBitmap(data) {
    try {
        const blob = new Blob([data]);
        return await createImageBitmap(blob);
    } catch (e) {
        console.warn("Corrupt image detected, using placeholder.");
        corruptCount++;
        showCorruptWarning();

        const cvs = document.createElement('canvas');
        cvs.width = 800; cvs.height = 1100;
        const ctx = cvs.getContext('2d');
        ctx.fillStyle = "#fee2e2"; 
        ctx.fillRect(0,0,cvs.width,cvs.height);
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 15;
        ctx.strokeRect(20,20,cvs.width-40,cvs.height-40);
        ctx.fillStyle = "#b91c1c";
        ctx.font = "bold 60px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("CORRUPT", cvs.width/2, cvs.height/2 - 40);
        ctx.fillText("IMAGE", cvs.width/2, cvs.height/2 + 40);
        return await createImageBitmap(cvs);
    }
}

function showCorruptWarning() {
    let el = document.getElementById('corrupt-warn-msg');
    if(!el) {
        el = document.createElement('div');
        el.id = 'corrupt-warn-msg';
        el.style.color = 'var(--danger)';
        el.style.background = 'var(--warning-bg)';
        el.style.padding = '12px';
        el.style.borderRadius = '8px';
        el.style.marginTop = '15px';
        el.style.textAlign = 'center';
        el.style.fontWeight = 'bold';
        el.style.border = '1px solid var(--warning-text)';
        els.progress.appendChild(el);
    }
    el.innerText = `⚠️ Warning: ${corruptCount} corrupt image(s) detected and replaced with placeholders.`;
    el.style.display = 'block';
}

function resetCorruptState() {
    corruptCount = 0;
    const el = document.getElementById('corrupt-warn-msg');
    if(el) el.style.display = 'none';
}

// --- MERGE FUNCTION ---
async function createMergedUrl(pair, isRTL) {
    const ctx = els.canvas.getContext('2d');
    const b1 = await safeGetBitmap(pair[0].data);
    let b2 = null;
    if(pair[1]) b2 = await safeGetBitmap(pair[1].data);

    if(!b2) {
        els.canvas.width = b1.width;
        els.canvas.height = b1.height;
        ctx.drawImage(b1, 0, 0);
    } else {
        els.canvas.width = b1.width + b2.width;
        els.canvas.height = Math.max(b1.height, b2.height);
        ctx.fillStyle="#fff"; 
        ctx.fillRect(0,0,els.canvas.width,els.canvas.height);

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

function addToGrid(grid, url, isMerge, imgContext = null) {
    const div = document.createElement('div');
    div.className = `gallery-item ${isMerge?'merge-item':''}`;
    div.innerHTML = `<img src="${url}" loading="lazy">`;
    div.onclick = () => openModal(url, imgContext, grid);
    grid.appendChild(div);
}

// --- UPDATED MODAL LOGIC (Navigation + Scroll Lock) ---
function openModal(src, restoreContext = null, sourceGrid = null) {
    if(dataTransferred) return;
    
    // 1. Set Image
    els.modalImg.src = src;
    els.modal.style.display = 'flex';
    
    // 2. Lock Scroll
    document.body.classList.add('no-scroll');

    // 3. Setup Navigation List
    if (sourceGrid) {
        const imgs = sourceGrid.querySelectorAll('img');
        currentModalList = Array.from(imgs).map(img => img.src);
        currentModalIndex = currentModalList.indexOf(src);
    } else {
        currentModalList = [];
        currentModalIndex = -1;
    }
    
    document.querySelector('.modal-prev').style.display = currentModalList.length > 1 ? 'flex' : 'none';
    document.querySelector('.modal-next').style.display = currentModalList.length > 1 ? 'flex' : 'none';

    // 4. Handle Delete/Restore Context
    if (restoreContext && els.modalActions) {
        currentModalImage = restoreContext.imgObject;
        currentModalGroup = restoreContext.group;
        els.modalActions.style.display = 'flex';
        
        if (restoreContext.isNormal) {
            els.modalReason.innerText = "Current Image";
            els.modalRestoreBtn.style.display = 'none';
            els.modalDeleteBtn.style.display = 'inline-block';
        } else {
            els.modalReason.innerText = `Filtered: ${restoreContext.reason}`;
            els.modalRestoreBtn.style.display = 'inline-block';
            els.modalDeleteBtn.style.display = 'none';
        }
    } else {
        currentModalImage = null;
        currentModalGroup = null;
        if(els.modalActions) els.modalActions.style.display = 'none';
    }
}

window.changeModalImage = function(direction) {
    if (currentModalList.length <= 1) return;
    currentModalIndex += direction;
    if (currentModalIndex < 0) currentModalIndex = currentModalList.length - 1; 
    if (currentModalIndex >= currentModalList.length) currentModalIndex = 0;
    const nextSrc = currentModalList[currentModalIndex];
    els.modalImg.src = nextSrc;
    if(els.modalActions) els.modalActions.style.display = 'none';
};

// Button Events
if(els.modalRestoreBtn) {
    els.modalRestoreBtn.onclick = () => {
        if (currentModalImage && currentModalGroup) {
            currentModalImage.forceKeep = true;
            currentModalImage.userDeleted = false;
            applyFiltersToAll();
            closeModal();
            clearAndRender();
        }
    };
}

if(els.modalDeleteBtn) {
    els.modalDeleteBtn.onclick = () => {
        if (currentModalImage && currentModalGroup) {
            currentModalImage.userDeleted = true;
            currentModalImage.forceKeep = false;
            applyFiltersToAll();
            closeModal();
            clearAndRender();
        }
    };
}

document.querySelector('.close-modal').onclick = closeModal;
els.modal.onclick = (e) => { if(e.target === els.modal) closeModal(); };

function closeModal() {
    els.modal.style.display = 'none';
    document.body.classList.remove('no-scroll');
    currentModalList = [];
}

document.onkeydown = (e) => {
    if(els.modal.style.display === 'flex') {
        if (e.key === 'Escape') closeModal();
        if (e.key === 'ArrowLeft')  { e.preventDefault(); window._animateSlide ? window._animateSlide(-1) : changeModalImage(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); window._animateSlide ? window._animateSlide(1)  : changeModalImage(1);  }
    }
};

// --- TOUCH/SWIPE GESTURE SUPPORT ---
(function initSwipe() {
    const SWIPE_THRESHOLD = 50;   // Min px to count as a swipe
    const SWIPE_MAX_VERT  = 100;  // Max vertical drift allowed
    const ANIM_DURATION   = 300;  // ms for slide animation

    let touchStartX = 0;
    let touchStartY = 0;
    let isDragging  = false;

    // Visual swipe hint that briefly appears when modal first opens
    function showSwipeHint() {
        if (currentModalList.length <= 1) return;
        let hint = document.getElementById('swipe-hint');
        if (!hint) {
            hint = document.createElement('div');
            hint.id = 'swipe-hint';
            hint.style.cssText = `
                position:absolute; bottom:80px; left:50%; transform:translateX(-50%);
                background:rgba(0,0,0,0.55); color:white; padding:8px 18px;
                border-radius:30px; font-size:0.82rem; font-weight:600; pointer-events:none;
                display:flex; align-items:center; gap:8px; white-space:nowrap;
                backdrop-filter:blur(6px); border:1px solid rgba(255,255,255,0.15);
                transition: opacity 0.4s ease;
            `;
            hint.innerHTML = '👈 Swipe to navigate 👉';
            els.modal.appendChild(hint);
        }
        hint.style.opacity = '1';
        clearTimeout(hint._fadeTimer);
        hint._fadeTimer = setTimeout(() => { hint.style.opacity = '0'; }, 1800);
    }

    // Animate the image sliding out and new one sliding in
    function animateSlide(direction) {
        const img = els.modalImg;
        const outX = direction > 0 ? '-60px' : '60px';
        const inX  = direction > 0 ? '60px'  : '-60px';

        // Slide out
        img.style.transition = `transform ${ANIM_DURATION}ms ease, opacity ${ANIM_DURATION}ms ease`;
        img.style.transform  = `translateX(${outX})`;
        img.style.opacity    = '0';

        setTimeout(() => {
            changeModalImage(direction);
            // Reset position instantly (no transition), then animate in
            img.style.transition = 'none';
            img.style.transform  = `translateX(${inX})`;
            img.style.opacity    = '0';

            // Force reflow so the browser registers the reset
            void img.offsetWidth;

            img.style.transition = `transform ${ANIM_DURATION}ms ease, opacity ${ANIM_DURATION}ms ease`;
            img.style.transform  = 'translateX(0)';
            img.style.opacity    = '1';
        }, ANIM_DURATION);
    }

    els.modal.addEventListener('touchstart', (e) => {
        if (currentModalList.length <= 1) return;
        touchStartX = e.changedTouches[0].clientX;
        touchStartY = e.changedTouches[0].clientY;
        isDragging  = true;

        // Live drag feedback
        els.modalImg.style.transition = 'none';
    }, { passive: true });

    els.modal.addEventListener('touchmove', (e) => {
        if (!isDragging || currentModalList.length <= 1) return;
        const dx = e.changedTouches[0].clientX - touchStartX;
        // Shift image slightly to follow finger
        els.modalImg.style.transform = `translateX(${dx * 0.3}px)`;
    }, { passive: true });

    els.modal.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        isDragging = false;

        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;

        // Reset image position
        els.modalImg.style.transition = `transform ${ANIM_DURATION}ms ease, opacity ${ANIM_DURATION}ms ease`;
        els.modalImg.style.transform  = 'translateX(0)';
        els.modalImg.style.opacity    = '1';

        if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_MAX_VERT) {
            // Enough horizontal swipe — navigate
            animateSlide(dx < 0 ? 1 : -1);
        }
    }, { passive: true });

    // Expose for keyboard handler
    window._animateSlide = animateSlide;

    // Show hint whenever modal opens with multiple images
    const _origOpenModal = openModal;
    window.openModal = function(...args) {
        _origOpenModal(...args);
        // Small delay so list is populated first
        setTimeout(showSwipeHint, 200);
    };
    // Make local calls use the patched version too
    window._showSwipeHint = showSwipeHint;
})();

// --- DOWNLOAD ---
els.downloadBtn.onclick = async () => {
    if(!rawGroups.length || dataTransferred) return;

    els.downloadBtn.disabled = true;
    els.downloadBtn.innerText = "Packing Data...";
    els.progress.style.display = 'block';

    let finalGroups = [];
    const transferBuffers = [];

    if(currentMode === 'merge') {
        updateProgress("Merging images for export...", 0);
        const isRTL = document.getElementById('rtl-mode').checked;
        resetCorruptState(); 

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
                transferBuffers.push(buf);
                mergedImages.push({ name: `page_${String(j).padStart(4,'0')}.jpg`, data: new Uint8Array(buf), ext: 'jpg' });
                URL.revokeObjectURL(url); 
            }
            finalGroups.push({ groupName: g.groupName, images: mergedImages });
        }
    } else {
        updateProgress("Preparing data transfer...", 90);
        finalGroups = rawGroups.map(g => ({
            groupName: g.groupName,
            images: g.displayImages.map(img => {
                if(img.data.buffer) transferBuffers.push(img.data.buffer);
                return { name: img.name, data: img.data, ext: img.ext };
            })
        }));
    }

    updateProgress("Sending to Worker...", 95);
    worker.postMessage({ type: 'zip', groups: finalGroups, extType: 'cbz' }, transferBuffers);
};

window.setMode = (mode) => {
    if(dataTransferred) return;
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

function downloadBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

init();
