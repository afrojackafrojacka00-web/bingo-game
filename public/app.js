// ---------------- BOOT SAFETY NET ----------------
// Some Telegram in-app browsers (mainly certain Android builds, and some
// privacy-restricted WebView configs) throw when touching localStorage, or
// hit some other early error we've never seen in a normal desktop/mobile
// browser. Previously that meant an uncaught exception during page boot —
// nothing had shown yet (the login card only appears once JS runs), so the
// result was a silent blank/black screen with no visible clue why. These two
// listeners turn any such early failure into an on-screen message instead of
// nothing, and are deliberately the very first thing this file does so they
// catch errors as early as possible. Once real UI has shown (see
// `markAppBooted()`), we stop intercepting — later runtime errors are
// handled locally by whichever feature hit them, same as before.
let appBooted = false;
function markAppBooted() { appBooted = true; }
function showBootError(message) {
    if (appBooted) return;
    let box = document.getElementById('bootErrorBox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'bootErrorBox';
        box.style.cssText = 'position:fixed;inset:0;background:#0b0f14;color:#e8eef6;padding:24px 20px;font:14px/1.6 system-ui,-apple-system,sans-serif;z-index:99999;overflow:auto;';
        document.body.appendChild(box);
    }
    box.innerHTML =
        '<h3 style="color:#fca5a5;margin:0 0 10px;">Could not load the app</h3>' +
        '<p style="opacity:.85;word-break:break-word;">' + String(message || 'Unknown error').replace(/</g, '&lt;') + '</p>' +
        '<button onclick="location.reload()" style="width:auto;padding:10px 18px;margin-top:10px;border-radius:10px;border:none;background:#3b82f6;color:#fff;font-weight:600;">Reload</button>';
}
window.addEventListener('error', (e) => showBootError(e?.message || 'Script error'));
window.addEventListener('unhandledrejection', (e) => {
    const reason = e?.reason;
    showBootError((reason && (reason.message || String(reason))) || 'Unhandled error');
});

// ---------------- Storage that never throws ----------------
// localStorage can throw (privacy modes, some in-app browsers, storage
// quota/policy restrictions) — every read/write in this file goes through
// this wrapper so a blocked storage API degrades to "not remembered" instead
// of crashing the whole app.
const safeStorage = {
    get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); return true; } catch (_) { return false; } },
    remove(key) { try { localStorage.removeItem(key); } catch (_) {} },
};

let currentUsername = "";
let currentStake = null;
let pendingStake = null;
let currentRoom = null;
let cachedCards = null;
let lobbyTimerInterval = null;
let lobbyDeadline = null;
let lobbyServerOffset = 0;
let notificationRefreshTimer = null;
const selectedCards = new Set();
const takenCardsMap = {};
const socket = (typeof io === 'function')
  ? io({ transports: ['websocket', 'polling'] })
  : { on() {}, emit() {}, connect() {}, disconnect() {} };
if (typeof io !== 'function') {
  console.error('socket.io failed to load');
}


// Telegram's in-app browser blocks/misbehaves with native confirm()/alert()
// popups in a lot of client versions, so we route those through Telegram's
// own dialog instead. But the telegram-web-app.js script defines
// `Telegram.WebApp` and its methods on ANY page that includes it — including
// this plain website — even when there's no real Telegram app on the other
// end to answer them. Calling showConfirm()/showAlert() in that situation
// just hangs forever waiting for a reply that never comes, which is why
// Leave appeared to do nothing at all on the website. `initData` is only
// ever non-empty when the page is genuinely opened inside Telegram (this
// codebase already uses the same signal to choose the Telegram vs. web login
// flow), so gate on that instead of just on the method existing.
function isTelegramClient() {
    return !!window.Telegram?.WebApp?.initData;
}

// ---- Web session (localStorage) ----
// Remember username for convenience, but expire after inactivity so a shared
// browser does not stay logged in forever.
const WEB_SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const WEB_SESSION_ACTIVITY_KEY = 'bingoLastActive';

function touchWebSession() {
    try { safeStorage.set(WEB_SESSION_ACTIVITY_KEY, String(Date.now())); } catch (_) {}
}

function clearWebSession() {
    try {
        safeStorage.remove('bingoUser');
        safeStorage.remove(WEB_SESSION_ACTIVITY_KEY);
    } catch (_) {}
}

function getSavedWebUserIfActive() {
    // Telegram Mini App is bound to the Telegram account — do not idle-logout there.
    if (isTelegramClient()) {
        return safeStorage.get('bingoUser');
    }
    const saved = safeStorage.get('bingoUser');
    if (!saved) return null;
    const last = Number(safeStorage.get(WEB_SESSION_ACTIVITY_KEY) || 0);
    if (!last || (Date.now() - last) > WEB_SESSION_IDLE_MS) {
        clearWebSession();
        return null;
    }
    touchWebSession();
    return saved;
}

function startWebSessionWatch() {
    if (isTelegramClient()) return;
    // Refresh activity on user interaction
    const bump = () => { if (currentUsername) touchWebSession(); };
    ['click', 'keydown', 'touchstart', 'scroll'].forEach(ev => {
        document.addEventListener(ev, bump, { passive: true });
    });
    // Periodic check
    setInterval(() => {
        if (!currentUsername || isTelegramClient()) return;
        const last = Number(safeStorage.get(WEB_SESSION_ACTIVITY_KEY) || 0);
        if (!last || (Date.now() - last) > WEB_SESSION_IDLE_MS) {
            logoutUser();
            alertUser('You were logged out due to inactivity. Please log in again.');
        }
    }, 60 * 1000);
}



function confirmAction(message) {
    return new Promise(resolve => {
        if (isTelegramClient()) window.Telegram.WebApp.showConfirm(message, ok => resolve(!!ok));
        else resolve(window.confirm(message));
    });
}

function alertUser(message) {
    if (isTelegramClient()) window.Telegram.WebApp.showAlert(message);
    else window.alert(message);
}

socket.on('connect', () => {
    setConnection(true);
    // Covers first load AND every automatic reconnect (screen wake, dropped
    // signal, backgrounded app, etc.) — re-sync so the UI never gets stuck
    // showing a stale screen after the connection comes back.
    resyncCurrentRoom();
});
socket.on('disconnect', () => setConnection(false));

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resyncCurrentRoom();
});

socket.on('rooms_state', rooms => {
    window.latestRooms = rooms || [];
    renderRooms();
});

socket.on('room_state', state => {
    if (currentStake === Number(state.stake)) {
        currentRoom = state;
        syncRoomUI(state);
        startLobbyTimer(state);
    }
    renderRooms();
});

socket.on('room_tick', state => {
    if (currentStake === Number(state.stake)) {
        currentRoom = { ...currentRoom, ...state };
        syncRoomUI(currentRoom);
        startLobbyTimer(currentRoom);
    }
    updateRoomInList(state);
});

socket.on('my_cards', ({ stake, cards }) => {
    if (Number(stake) !== currentStake) return;
    selectedCards.clear();
    (cards || []).forEach(c => selectedCards.add(Number(c)));
    updateGridUI();
    updateSelectedCount();
});

socket.on('number_drawn', ({ stake, number }) => {
    if (Number(stake) !== currentStake) return;
    currentRoom = currentRoom || {};
    currentRoom.drawn = currentRoom.drawn || [];
    currentRoom.drawn.push(Number(number));
    updateCalledNumbers();
});

socket.on('game_started', ({ stake, gameId }) => {
    if (Number(stake) !== currentStake) return;
    safeStorage.set('bingoActiveGame', JSON.stringify({username: currentUsername, stake:Number(stake), gameId}));
    window.location.href = `/game.html?stake=${encodeURIComponent(stake)}`;
});

socket.on('game_ended', async ({ stake, winner, prize }) => {
    if (Number(stake) !== currentStake) return;
    // A real winner gets an alert here. When nobody wins (all 75 numbers called),
    // the room_reset message right below already explains what happened —
    // showing both would just double up the popups.
    if (winner && winner !== 'No One') {
        alert(`🏆 ${winner} won ${Number(prize).toFixed(2)} Birr!`);
    }
    await loadUserData(currentUsername);
    location.href = `/index.html?returnStake=${encodeURIComponent(stake)}`;
});

socket.on('room_reset', async ({ stake, message }) => {
    if (Number(stake) !== currentStake) return;
    stopLobbyTimer();
    resetReadyButton();
    selectedCards.clear();
    await loadUserData(currentUsername);
    if (message) alert(message);
    location.href = `/index.html?returnStake=${encodeURIComponent(stake)}`;
});

socket.on('error_message', ({ message }) => showNotification(message));

// ---------------- RECONNECT / RESYNC ----------------
// Everything a player does mid-game lives on the server (readyPlayers,
// selectedCards, the draw timer) and is keyed by username, not by socket id —
// so a dropped connection never removes anyone from a running game. What it
// DOES lose is Socket.IO "room" membership, which is how the server delivers
// number_drawn / game_ended / room_reset broadcasts. This function re-joins
// the room and pulls the true current state any time the connection comes
// back or the tab/screen becomes visible again, so the player either catches
// back up to a still-running game or is dropped straight to the lobby if it
// already finished while they were away.
async function resyncCurrentRoom() {
    if (!currentStake || !currentUsername) return;
    const stake = currentStake;

    socket.emit('subscribe_room', { stake, username: currentUsername }, async response => {
        if (currentStake !== stake) return; // user already navigated away
        if (!response?.success || !response.state) return;

        const state = response.state;

        if (!state.playerInRoom) {
            // The game ended while the phone/tab was asleep. Go directly into
            // the same stake's fresh card-selection flow, not the money rooms.
            location.href = `/index.html?returnStake=${encodeURIComponent(stake)}`;
            return;
        }

        currentRoom = { ...currentRoom, ...state };
        selectedCards.clear();
        (state.selectedCards || []).forEach(c => selectedCards.add(Number(c)));
        Object.keys(takenCardsMap).forEach(k => delete takenCardsMap[k]);
        (state.takenCards || []).forEach(cardNum => {
            if (!selectedCards.has(Number(cardNum))) takenCardsMap[cardNum] = true;
        });

        if (state.status === 'PLAYING' || state.status === 'FINISHING') {
            // Never revive the old in-page game UI after sleep/wake.
            safeStorage.set('bingoActiveGame', JSON.stringify({ username: currentUsername, stake:Number(stake), gameId:state.gameId }));
            location.href = `/game.html?stake=${encodeURIComponent(stake)}`;
            return;
        } else if (state.status === 'JOINING') {
            hide('homeBox');
            hide('roomsBox');
            hide('gamePlayBox');
            show('selectionBox');
            await ensureCardsCached();
            renderCardNumbers(cachedCards);
            syncRoomUI(currentRoom);
            startLobbyTimer(currentRoom);

            const btn = document.getElementById('playGameBtn');
            if (state.isReady) {
                if (btn) {
                    btn.disabled = true;
                    btn.dataset.ready = '1';
                    btn.innerText = 'READY — Waiting for start...';
                }
            } else {
                resetReadyButton();
            }
        }
    });
}

let cardsOffset = 0, cardsHasMore = true, cardsLoading = false, cardSearchQ = '';
async function ensureCardsCached() {
    if (cachedCards && cachedCards.length) return;
    cardsOffset = 0; cardsHasMore = true;
    await loadMoreCards(true);
}
async function loadMoreCards(reset) {
    if (cardsLoading || (!cardsHasMore && !reset)) return;
    cardsLoading = true;
    try {
        const q = cardSearchQ ? `&q=${encodeURIComponent(cardSearchQ)}` : '';
        const res = await fetch(`/api/cards/numbers?limit=100&offset=${reset?0:cardsOffset}${q}`, {cache:'no-store'});
        const data = await res.json();
        if (!data.success) return;
        if (reset) cachedCards = data.cardNumbers || [];
        else cachedCards = (cachedCards || []).concat(data.cardNumbers || []);
        cardsOffset = cachedCards.length;
        cardsHasMore = !!data.hasMore;
        renderCardNumbers(cachedCards);
    } finally { cardsLoading = false; }
}
let searchDebounce;
function searchCards(val) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
        cardSearchQ = (val || '').trim();
        cardsOffset = 0; cardsHasMore = true;
        await loadMoreCards(true);
        if (cardSearchQ && /^\d+$/.test(cardSearchQ)) previewCard(Number(cardSearchQ));
        else document.getElementById('cardPreview')?.classList.add('hidden');
    }, 250);
}
async function previewCard(num) {
    const el = document.getElementById('cardPreview');
    if (!el) return;
    try {
        const res = await fetch(`/api/cards/${num}`, {cache:'no-store'});
        const data = await res.json();
        if (!data.success) { el.classList.add('hidden'); return; }
        const g = data.card.grid;
        const taken = !!takenCardsMap[num];
        const mine = selectedCards.has(num);
        el.innerHTML = `<div style="background:var(--preview-bg);border-radius:10px;padding:10px;color:var(--preview-text);border:1px solid var(--preview-border);">
          <b style="color:var(--text-color);">Card #${num}</b> <span style="color:var(--text-color);">${mine?'(yours)':taken?'(taken)':'(available)'}</span>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px;margin-top:8px;font-size:11px;">
          ${g.map((row,r)=>row.map((v,c)=>`<span style="background:var(--input-bg);padding:4px 0;text-align:center;border-radius:4px;color:var(--input-text);border:1px solid var(--input-border);">${v==='FREE'||(r===2&&c===2)?'★':v}</span>`).join('')).join('')}
          </div>
          ${!taken&&!mine?`<button class="btn-play" style="margin-top:8px;background:var(--blue);color:#fff;padding:8px 16px;font-size:14px;border:none;border-radius:8px;cursor:pointer;" onclick="toggleCard(${num})">Select this card</button>`:''}
        </div>`;
        el.classList.remove('hidden');
    } catch { el.classList.add('hidden'); }
}
//12345


function setConnection(online) {
    const dot = document.getElementById('connectionDot');
    if (!dot) return;
    dot.classList.toggle('online', online);
    dot.classList.toggle('offline', !online);
}

function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

function showNotification(message) {
    const el = document.getElementById('lockoutNotice');
    if (!el) return alert(message);
    el.innerText = message;
    show('lockoutNotice');
    setTimeout(() => {
        if (el.innerText === message) hide('lockoutNotice');
    }, 4000);
}


function stopLobbyTimer() {
    if (lobbyTimerInterval) {
        clearInterval(lobbyTimerInterval);
        lobbyTimerInterval = null;
    }
}

function startLobbyTimer(room) {
    stopLobbyTimer();

    if (!room || room.status !== 'JOINING' || !room.deadline) return;

    lobbyDeadline = Number(room.deadline);
    lobbyServerOffset = Number(room.serverNow || Date.now()) - Date.now();

    const update = () => {
        const estimatedServerNow = Date.now() + lobbyServerOffset;
        const remaining = Math.max(
            0,
            Math.ceil((lobbyDeadline - estimatedServerNow) / 1000)
        );

        const timer = document.getElementById('lobbyTimer');
        if (timer) timer.innerText = `${remaining}s`;

        if (remaining <= 0) stopLobbyTimer();
    };

    update();
    lobbyTimerInterval = setInterval(update, 250);
}

function resetReadyButton() {
    const btn = document.getElementById('playGameBtn');
    if (!btn) return;
    delete btn.dataset.ready;
    btn.innerText = 'READY';
    btn.disabled = selectedCards.size === 0;
}

function formatStatus(room) {
    if (!room) return 'Waiting';
    if (room.status === 'PLAYING') return '🔴 Playing';
    if (room.status === 'JOINING') return `🟡 Joining · ${room.timer}s`;
    return '⚪ Waiting';
}

function renderRooms() {
    const list = document.getElementById('roomsList');
    if (!list || document.getElementById('roomsBox').classList.contains('hidden')) return;

    const rooms = window.latestRooms || [];
    list.innerHTML = rooms.map(room => {
        const statusClass = String(room.status || 'WAITING').toLowerCase();
        const disabled = room.status === 'PLAYING';
        return `<div class="room-row">
            <div>
                <div class="room-stake">💰 ${Number(room.stake).toFixed(0)} Birr</div>
                <div class="room-meta">Players | ${room.totalCards || 0}</div>
            </div>
            <div class="room-status ${statusClass}">
                🏆 ${Number(room.prizePool).toFixed(2)} Birr<br>
                ${formatStatus(room)}
            </div>
            <button class="room-join" ${disabled ? 'disabled' : ''} onclick="joinRoom(${Number(room.stake)})">${disabled ? 'PLAYING' : 'JOIN'}</button>
        </div>`;
    }).join('');

    renderMyGame();
}

function renderMyGame() {
    const box = document.getElementById('myGameBox');
    if (!box) return;
    if (!currentStake || !currentRoom || currentRoom.status === 'PLAYING') {
        hide('myGameBox');
        return;
    }
    box.innerHTML = `<h3 style="margin-top:0">🎮 Your Current Game</h3>
        <div class="info-grid">
          <div class="info-box"><span>STAKE</span><strong>${currentStake} Birr</strong></div>
          <div class="info-box"><span>PLAYERS</span><strong>${currentRoom.players}</strong></div>
          <div class="info-box"><span>PRIZE POOL</span><strong>${Number(currentRoom.prizePool).toFixed(2)} Birr</strong></div>
          <div class="info-box"><span>STATUS</span><strong>${formatStatus(currentRoom)}</strong></div>
        </div>
        <button class="btn-play" onclick="returnToSelection()">Return to Game</button>`;
    show('myGameBox');
}

function updateRoomInList(state) {
    const rooms = window.latestRooms || [];
    const i = rooms.findIndex(r => Number(r.stake) === Number(state.stake));
    if (i >= 0) rooms[i] = { ...rooms[i], ...state };
    window.latestRooms = rooms;
    renderRooms();
}

function joinRoom(stake) {
    if (currentStake && currentStake !== Number(stake)) {
        return alert(`You are already in the ${currentStake} Birr room.`);
    }
    const room = (window.latestRooms || []).find(r => Number(r.stake) === Number(stake));
    if (!room || room.status === 'PLAYING') return;
    pendingStake = Number(stake);
    confirmJoin();
}

function closeJoinModal() {
    pendingStake = null;
    hide('joinModal');
}

function confirmJoin() {
    if (!pendingStake || !currentUsername) return;
    const stake = pendingStake;
    socket.emit('join_room', { stake, username: currentUsername }, async response => {
        if (!response?.success) return alert(response?.message || 'Unable to join room.');

        currentStake = stake;
        currentRoom = response.room;
        selectedCards.clear();
        Object.keys(takenCardsMap).forEach(k => delete takenCardsMap[k]);
        closeJoinModal();
        socket.emit('subscribe_room', { stake, username: currentUsername }, response2 => {
            if (response2?.success && response2.state) {
                currentRoom = { ...currentRoom, ...response2.state };
                selectedCards.clear();
                (response2.state.selectedCards || []).forEach(c => selectedCards.add(Number(c)));

                if (response2.state.isReady) {
                    const btn = document.getElementById('playGameBtn');
                    if (btn) {
                        btn.disabled = true;
                        btn.dataset.ready = '1';
                        btn.innerText = 'READY — Waiting for start...';
                    }
                } else {
                    resetReadyButton();
                }

                startLobbyTimer(currentRoom);
            }
        });
        await loadUserData(currentUsername);
        await openSelection();
    });
}

async function goToGameScreen() {
    hide('homeBox');
    if (typeof disconnectInstantSocket === 'function') disconnectInstantSocket();
    show('roomsBox');
    socket.emit('rooms_state_request'); // harmless for older/newer server versions
    renderRooms();
}

function showHome() {
    hide('roomsBox');
    hide('selectionBox');
    hide('gamePlayBox');
    hide('instantBox');
    hide('instantPlayBox');
    hide('instantWaitOverlay');
    if (typeof setInstantImmersive === 'function') setInstantImmersive(false);
    if (typeof stopInstantSelectTimer === 'function') stopInstantSelectTimer();
    if (typeof stopInstantDraw === 'function') stopInstantDraw();
    if (typeof disconnectInstantSocket === 'function') disconnectInstantSocket();
    try {
        instantPendingPlay = null;
        instantLocked = false;
        instantWatchMode = false;
        const btn = document.getElementById('instantJoinBtn');
        if (btn) btn.disabled = false;
        const sel = document.getElementById('instantStake');
        if (sel) sel.disabled = false;
    } catch (_) {}
    show('homeBox');
}

function returnToRooms() {
    stopLobbyTimer();
    resetReadyButton();

    if (currentStake) {
        socket.emit('unsubscribe_room', { stake: currentStake });
    }

    currentStake = null;
    currentRoom = null;
    selectedCards.clear();
    Object.keys(takenCardsMap).forEach(k => delete takenCardsMap[k]);
    hide('selectionBox');
    hide('gamePlayBox');
    show('roomsBox');
    renderRooms();
}

async function leaveCurrentRoom() {
    if (!currentStake) return returnToRooms();
    const ok = await confirmAction(`Leave the ${currentStake} Birr room? Your stake will be refunded if the game has not started.`);
    if (!ok) return;

    socket.emit('leave_room', { stake: currentStake, username: currentUsername }, async response => {
        if (!response?.success) return alertUser(response?.message || 'Unable to leave room.');
        await loadUserData(currentUsername);
        returnToRooms();
    });
}

async function openSelection() {
    hide('homeBox');
    hide('roomsBox');
    hide('gamePlayBox');
    show('selectionBox');
    document.getElementById('selectionTitle').innerText = ` ${currentStake} Birr`;

    await ensureCardsCached();
    if (!cachedCards) return showNotification('Failed to load cards.');
    renderCardNumbers(cachedCards);
}

function returnToSelection() {
    if (!currentStake) return;
    hide('roomsBox');
    hide('gamePlayBox');
    show('selectionBox');
}

function renderCardNumbers(cardNumbers) {
    const grid = document.getElementById('cardGrid');
    if (!grid) return;
    grid.innerHTML = (cardNumbers || []).map(number =>
        `<div class="card-item" data-card="${number}" onclick="toggleCard(${number})">${number}</div>`
    ).join('') + (cardsHasMore ? '<div id="cardSentinel" style="grid-column:1/-1;height:20px;"></div>' : '');
    updateGridUI();
    updateSelectedCount();
    const sent = document.getElementById('cardSentinel');
    if (sent && !sent._obs) {
        sent._obs = new IntersectionObserver(entries => { if (entries[0].isIntersecting) loadMoreCards(false); }, {root:grid, rootMargin:'100px'});
        sent._obs.observe(sent);
    }
}

function toggleCard(cardNumber) {
    if (!currentStake || currentRoom?.status !== 'JOINING') return;

    socket.emit(
        'toggle_card',
        { stake: currentStake, cardNumber, username: currentUsername },
        response => {
            if (!response?.success) {
                return showNotification(response?.message || 'Could not update card.');
            }

            if (response.balance !== undefined) {
                const balance = document.getElementById('balanceDisplay');
                if (balance) balance.innerText = Number(response.balance).toFixed(2);
            }
        }
    );
}

function updateGridUI() {
    document.querySelectorAll('.card-item').forEach(el => {
        const cardNumber = Number(el.dataset.card);
        const isMine = selectedCards.has(cardNumber);
        const isTaken = !!takenCardsMap[cardNumber];

        el.classList.toggle('selected', isMine);
        el.classList.toggle('taken', isTaken && !isMine);
    });
}

function updateSelectedCount() {
    const count = selectedCards.size;
    document.getElementById('selectedCount').innerText = count;

    const btn = document.getElementById('playGameBtn');
    if (!btn) return;

    if (btn.dataset.ready === '1') {
        btn.disabled = true;
        return;
    }

    btn.disabled = count === 0;
}

function syncRoomUI(room) {
    if (!room) return;

    const timer = document.getElementById('lobbyTimer');
    if (timer) timer.innerText = `${Math.max(0, Number(room.timer || 0))}s`;

    const readyCount = document.getElementById('readyCount');
    if (readyCount) readyCount.innerText = room.readyPlayers || 0;

    const lobbyStatus = document.getElementById('lobbyStatus');
    if (lobbyStatus) lobbyStatus.innerText = formatStatus(room);

    if (room.takenCards) {
        Object.keys(takenCardsMap).forEach(k => delete takenCardsMap[k]);
        room.takenCards.forEach(cardNum => {
            if (!selectedCards.has(Number(cardNum))) {
                takenCardsMap[cardNum] = true;
            }
        });
        updateGridUI();
    }

    renderMyGame();
}

function launchGame() {
    if (!currentStake || selectedCards.size === 0) return;

    socket.emit(
        'player_ready',
        { stake: currentStake, username: currentUsername },
        response => {
            if (!response?.success) {
                return showNotification(response?.message || 'Could not mark ready.');
            }

            if (response.balance !== undefined) {
                const balance = document.getElementById('balanceDisplay');
                if (balance) balance.innerText = Number(response.balance).toFixed(2);
            }

            const btn = document.getElementById('playGameBtn');
            if (!btn) return;

            btn.disabled = true;
            btn.dataset.ready = '1';
            btn.innerText = 'READY — Waiting for start...';
        }
    );
}

// Legacy claim UI removed; live game claims only use game.html.

function renderMyGameCards(){ document.getElementById('myGameCards').innerHTML=''; }

function updateCalledNumbers() {
    const el = document.getElementById('calledNumbers');
    if (!el) return;
    const drawn = currentRoom?.drawn || [];
    el.innerHTML = drawn.length ? drawn.map(n=>`<span class="ball">${n}</span>`).join('') : '<span class="small">Waiting for first number…</span>';
}

// ---------------- AUTH / USER ----------------
window.addEventListener('DOMContentLoaded', async () => {
    // Referral capture: a link like yoursite.com/index.html?ref=CODE should
    // only ever be consumed once, by whoever registers next on this device —
    // stash it and strip the param immediately so it can't leak into a later
    // refresh/login the way returnStake used to.
    const refParam = new URLSearchParams(location.search).get('ref');
    if (refParam) {
        if (!safeStorage.get('bingoUser')) safeStorage.set('bingoReferralCode', refParam);
        history.replaceState(null, '', location.pathname);
    }

    const botLink = document.getElementById('telegramBotLink');
    if (botLink) {
        const botUser = 'kal_bingo_bot'; // keep in sync with TELEGRAM_BOT_USERNAME
        botLink.href = 'https://t.me/' + botUser;
    }

    const tg = window.Telegram?.WebApp;
    // Only real Mini App sessions have non-empty initData.
    // Loading telegram-web-app.js in a normal browser must NOT block web login.
    if (tg) {
        try { tg.ready(); } catch (_) {}
        try { tg.expand(); } catch (_) {}
    }

    let initData = (tg && tg.initData) ? String(tg.initData) : '';
    // Brief wait only when platform looks like Telegram but initData is late
    if (!initData && tg && tg.platform && tg.platform !== 'unknown') {
        for (let i = 0; i < 8 && !initData; i++) {
            await new Promise(r => setTimeout(r, 80));
            initData = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData)
                ? String(window.Telegram.WebApp.initData) : '';
        }
    }
    const insideTelegram = !!initData;

    if (initData) {
        document.getElementById('logoutBtn')?.classList.add('hidden');
        try {
            const res = await fetch('/api/telegram-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initData })
            });
            const data = await res.json();
            if (data.success && data.status === 'LOGGED_IN') {
                currentUsername = data.username;
                safeStorage.set('bingoUser', currentUsername);
                if (!data.phoneVerified) show('phoneModal');
                else await showHomeScreen(currentUsername);
            } else if (insideTelegram) {
                showTelegramAuthError(data.message || 'Telegram login failed.');
            } else {
                showAuthBox();
            }
        } catch (e) {
            if (insideTelegram) showTelegramAuthError('Network error during Telegram login.');
            else showAuthBox();
        }
    } else if (insideTelegram) {
        showTelegramAuthError('Open this app from your bot menu button (not the browser).');
    } else {
        const saved = getSavedWebUserIfActive();
        if (saved) await showHomeScreen(saved);
        else showAuthBox();
        startWebSessionWatch();
    }
});

function showTelegramAuthError(message) {
    const box = document.getElementById('authBox');
    if (box) {
        box.innerHTML = `
          <h2>Telegram login</h2>
          <p class="small" style="color:var(--notice-text,#fca5a5);">${String(message || 'Login failed')}</p>
          <p class="small">You are inside Telegram — username/password is only for the website.</p>
          <p class="small">1. Render env must have <strong>TELEGRAM_BOT_TOKEN</strong> = this bot’s token<br>
             2. Menu button URL must be your Render https URL<br>
             3. Close the Mini App and open it again from the bot menu</p>
          <button class="btn-play" onclick="location.reload()">Try again</button>
        `;
        show('authBox');
        hide('headerBar'); hide('bottomNav');
        markAppBooted();
    } else {
        alertUser(message || 'Telegram login failed');
    }
}

function showAuthBox() {
    show('authBox');
    hide('headerBar'); hide('bottomNav');
    document.querySelectorAll('.tab-content').forEach(t => hide(t.id));
    markAppBooted();
}

async function showHomeScreen(username) {
    currentUsername = username;
    safeStorage.set('bingoUser', username);
    touchWebSession();
    document.getElementById('playerDisplay').innerText = username;
    hide('authBox'); show('headerBar'); show('bottomNav');
    markAppBooted();
    applyLanguage(safeStorage.get('bingoLang') || 'en', false);
    switchTab('tabGames', document.querySelector('.nav-item'));
    showHome();

    await loadUserData(username);
    applyAccountTabForClient();
    await fetchNotifications(username);

    const searchParams = new URLSearchParams(location.search);
    const returnStake = Number(searchParams.get('returnStake') || 0);
    const view = searchParams.get('view');

    // These redirect params are meant to be used exactly once — right after
    // a game ends or a player leaves a live game. If we leave them sitting
    // in the address bar, a later page refresh, or a logout+login on the
    // same tab, sees the same old param and silently re-joins/re-opens that
    // room every time, even long after the player explicitly left. Strip it
    // from the URL the moment it's read so it can't fire again.
    if (returnStake || view) {
        history.replaceState(null, '', location.pathname);
    }

    if (returnStake) {
        setTimeout(()=>{ pendingStake=returnStake; confirmJoin(); }, 500);
    } else if (view === 'rooms') {
        // Landed here after leaving a live game — go straight to the stake
        // list (the "money choosing" page), not the home splash.
        goToGameScreen();
    }

    if (notificationRefreshTimer) clearInterval(notificationRefreshTimer);
    notificationRefreshTimer = setInterval(() => {
        if (currentUsername) fetchNotifications(currentUsername);
    }, 10000);

    loadReferralInfo(username);
}

// ---------------- REFERRALS (home page) ----------------
async function loadReferralInfo(username) {
    const box = document.getElementById('referralBox');
    if (!box || !username) return;
    try {
        const res = await fetch(`/api/referral-info?username=${encodeURIComponent(username)}`, { cache: 'no-store' });
        const data = await res.json();
        if (!data.success) return;

        const tg = data.telegramLink || '';
        const web = data.webLink || '';
        document.getElementById('referralLinkInput').value = tg || web;
        const webEl = document.getElementById('referralWebLinkInput');
        if (webEl) webEl.value = web;
        document.getElementById('referralProgressText').innerText =
            `${data.referralCount} joined so far · ${data.progressInMilestone}/${data.referralsRequired} toward your next ${data.rewardAmount} Birr bonus`;
    } catch (err) { console.error('Referral info error:', err); }
}

function copyReferralLink() {
    const input = document.getElementById('referralLinkInput');
    if (!input) return;
    navigator.clipboard?.writeText(input.value).then(
        () => showNotification('Referral link copied!'),
        () => {}
    );
}

function switchToRegister() { /* web registration disabled */ }
function switchToLogin() { /* login only */ }

async function loginUser() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    if (!username || !password) return alert('Please fill in all fields.');
    try {
        const res = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
        const data = await res.json();
        if (data.success) await showHomeScreen(data.username);
        else alert(data.message || 'Invalid credentials.');
    } catch { alert('Login failed.'); }
}

async function registerUser() {
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    const phoneNumber = document.getElementById('regPhone').value.trim();
    if (!username || !password) return alert('Please fill in username and password.');
    try {
        const referredBy = safeStorage.get('bingoReferralCode') || null;
        const res = await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,phoneNumber,referredBy})});
        const data = await res.json();
        if (data.success) {
            safeStorage.remove('bingoReferralCode');
            await showHomeScreen(data.username);
        } else alert(data.message || 'Registration failed.');
    } catch { alert('Registration failed.'); }
}

async function loadUserData(username) {
    try {
        const res = await fetch(`/api/user-details?username=${encodeURIComponent(username)}`);
        const data = await res.json();
        if (data.success && data.user) {
            const balance = Number(data.user.balance || 0).toFixed(2);
            document.getElementById('balanceDisplay').innerText = balance;
            const userField = document.getElementById('accountUsernameInput');
            if (userField && data.user.username) userField.value = data.user.username;

            const walletBalance = document.getElementById('walletBalanceDisplay');
            if (walletBalance) walletBalance.innerText = `${balance} Birr`;

            const bonusDisplay = document.getElementById('walletBonusDisplay');
            if (bonusDisplay) bonusDisplay.innerText = `Bonus: ${Number(data.user.bonus_balance || 0).toFixed(2)} Birr`;

            const display = data.user.display_name || data.user.username;
            const profileUsername = document.getElementById('profileUsername');
            if (profileUsername) profileUsername.innerText = display;
            const playerDisplay = document.getElementById('playerDisplay');
            if (playerDisplay) playerDisplay.innerText = display;

            const profilePhone = document.getElementById('profilePhone');
            if (profilePhone) profilePhone.innerText = data.user.phone_number || 'Not set';

            const lang = data.user.preferred_language || 'en';
            const langSelect = document.getElementById('languageSelect');
            if (langSelect) langSelect.value = lang;
            applyLanguage(lang, false);

            const theme = data.user.preferred_theme || 'dark';
            applyTheme(theme);
            const themeSelect = document.getElementById('themeSelect');
            if (themeSelect) themeSelect.value = theme;

            syncVoicePackUI(data.user.preferred_voice_pack || 'john');
        }
    } catch (err) { console.error(err); }
}

// ---------------- VOICE PACK (Account Settings) ----------------
function syncVoicePackUI(pack) {
    document.querySelectorAll('#voicePackPicker .voice-pack-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.pack === pack);
    });
}

async function selectVoicePack(pack) {
    syncVoicePackUI(pack); // instant feedback, corrected below if the save fails
    try {
        const res = await fetch('/api/user/voice-pack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUsername, voicePack: pack })
        });
        const data = await res.json();
        if (!data.success) alertUser(data.message || 'Could not save voice.');
    } catch {
        alertUser('Could not save voice.');
    }
}

// ---------------- INFINITE SCROLL (shared helper) ----------------
// Feed-style paging: render a small page, then load more only once the
// bottom of the list actually scrolls into view — instead of fetching and
// rendering the person's entire history/transaction log in one shot every
// time they open the tab.
const _scrollObservers = {};
function attachInfiniteScroll(container, sentinelId, loadMore) {
    let sentinel = document.getElementById(sentinelId);
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.id = sentinelId;
        sentinel.style.cssText = 'height:1px';
    }
    container.appendChild(sentinel); // moves it to the bottom if already present
    if (!_scrollObservers[sentinelId]) {
        _scrollObservers[sentinelId] = new IntersectionObserver(entries => {
            if (entries[0].isIntersecting) loadMore();
        }, { rootMargin: '250px' });
        _scrollObservers[sentinelId].observe(sentinel);
    }
}
function removeInfiniteScroll(sentinelId) {
    if (_scrollObservers[sentinelId]) {
        _scrollObservers[sentinelId].disconnect();
        delete _scrollObservers[sentinelId];
    }
    document.getElementById(sentinelId)?.remove();
}

// ---------------- HISTORY ----------------
const HISTORY_PAGE_SIZE = 15;
let historyOffset = 0, historyHasMore = true, historyLoading = false;

async function fetchHistory(username, reset = true) {
    if (!username) return;
    const container = document.getElementById('historyList');
    if (!container) return;

    if (reset) {
        historyOffset = 0;
        historyHasMore = true;
        removeInfiniteScroll('historySentinel');
        container.innerHTML = '<p class="small">Loading your game history…</p>';
    }
    if (!historyHasMore || historyLoading) return;
    historyLoading = true;

    try {
        const res = await fetch(`/api/history?username=${encodeURIComponent(username)}&limit=${HISTORY_PAGE_SIZE}&offset=${historyOffset}`, { cache: 'no-store' });
        const data = await res.json();
        if (!data.success) {
            if (reset) container.innerHTML = '<p class="small">Could not load history.</p>';
            return;
        }

        renderHistory(data.history || [], reset);
        historyOffset += (data.history || []).length;
        historyHasMore = !!data.hasMore;
        if (historyHasMore) attachInfiniteScroll(container, 'historySentinel', () => fetchHistory(username, false));
    } catch (err) {
        console.error('History fetch error:', err);
        if (reset) container.innerHTML = '<p class="small">Could not load history.</p>';
    } finally {
        historyLoading = false;
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function renderHistory(games, reset = true) {
    const container = document.getElementById('historyList');
    if (!container) return;

    if (reset) container.innerHTML = '';
    if (!games.length) {
        if (reset) container.innerHTML = '<p class="small">You haven\'t completed a game yet. Your finished games will show up here.</p>';
        return;
    }

    const html = games.map(game => {
        const won = !!game.won;
        const split = Number(game.winnerCount) > 1;
        const outcomeClass = won ? 'won' : 'lost';
        const outcomeLabel = won ? '🏆 You Won' : ((game.winner || split) ? '❌ You Lost' : '➖ No Winner');
        const dateStr = new Date(game.date).toLocaleString();

        const winners = Array.isArray(game.winners) ? game.winners : [];
        const winnerNames = split
            ? (winners.length
                ? winners.map(w => escapeHtml(w.displayName || w.username)).join(', ')
                : escapeHtml(game.winner || 'Multiple winners'))
            : escapeHtml(game.winner || 'None');

        const cardCell = (game.winningCardNumber || split)
            ? `<strong class="card-link" onclick="viewWinningCard(${Number(game.gameId)})">${split ? 'View Winning Cards' : '#' + Number(game.winningCardNumber)}</strong>`
            : `<strong>—</strong>`;

        return `<div class="history-card ${outcomeClass}">
            <div class="history-top">
                <span class="history-outcome">${outcomeLabel}</span>
                <span class="history-date">${dateStr}</span>
            </div>
            <div class="info-grid" style="margin:10px 0 0;">
                <div class="info-box"><span>PLAYERS</span><strong>${Number(game.players) || 0}</strong></div>
                <div class="info-box"><span>WINNER${split ? 'S' : ''}</span><strong>${split ? 'Split × ' + Number(game.winnerCount) : winnerNames}</strong>
                    ${split ? `<div class="small" style="margin-top:5px;line-height:1.45;">${winnerNames}</div>` : ''}
                </div>
                <div class="info-box"><span>PRIZE</span><strong>${Number(game.prizePool || 0).toFixed(2)} Birr</strong></div>
                <div class="info-box"><span>STAKE</span><strong>${Number(game.stake || 0).toFixed(0)} Birr</strong></div>
                <div class="info-box"><span>WINNING CARD${split ? 'S' : ''}</span>${cardCell}</div>
            </div>
        </div>`;
    }).join('');

    container.insertAdjacentHTML('beforeend', html);
}

// ---------------- HISTORY: WINNING CARD DETAIL ----------------
async function viewWinningCard(gameId) {
    const modal = document.getElementById('historyCardModal');
    const body = document.getElementById('historyCardBody');
    if (!modal || !body) return;

    body.innerHTML = '<p class="small">Loading card…</p>';
    show('historyCardModal');

    try {
        const res = await fetch(`/api/history/${encodeURIComponent(gameId)}`, { cache: 'no-store' });
        const data = await res.json();
        if (!data.success) {
            body.innerHTML = `<p class="small">${data.message || 'Could not load this card.'}</p>`;
            return;
        }

                const g = data.game;
        const winners = g.winners || [];

        if (winners.length === 1) {
            const w = winners[0];
            if (!Array.isArray(w.grid) || !w.grid.length) {
                body.innerHTML = `<p class="small">The winning card (#${Number(w.cardNumber) || 'unknown'}) was recorded, but its grid is unavailable in the card database.</p>`;
                return;
            }
            const winSet = new Set((w.winningCells || []).map(c => Array.isArray(c) ? c.join(',') : String(c)));
            const gridHtml = w.grid.map((row, r) => row.map((v, c) => {
                const isFree = v === 'FREE' || (r === 2 && c === 2);
                const isWin = winSet.has(`${r},${c}`);
                return `<span class="${isWin ? 'win' : ''}">${isFree ? 'FREE' : v}</span>`;
            }).join('')).join('');
            body.innerHTML = `
                <h3 style="margin:0 0 4px">Card #${w.cardNumber}</h3>
                <p class="small" style="margin:0 0 12px">${g.patternName} · Won by ${w.winnerDisplay} · ${Number(w.prize).toFixed(2)} Birr</p>
                <div class="winner-grid">${gridHtml}</div>`;
        } else {
            const cardsHtml = winners.map(w => {
                const winSet = new Set((w.winningCells || []).map(c => c.join(',')));
                const cells = (w.grid || []).flatMap((row, r) => row.map((v, c) => {
                    const isFree = v === 'FREE' || (r === 2 && c === 2);
                    const isWin = winSet.has(`${r},${c}`);
                    return `<span style="display:flex;align-items:center;justify-content:center;aspect-ratio:1;font-size:9px;border-radius:3px;background:${isWin ? '#00d26a' : 'rgba(255,255,255,0.08)'};color:${isWin ? '#04210f' : '#fff'};font-weight:${isWin ? '700' : '400'};">${isFree ? '★' : v}</span>`;
                }).join('')).join('');
                return `<div style="width:110px;text-align:center;">
                    <div style="font-size:11px;font-weight:600;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${w.winnerDisplay}</div>
                    <div style="font-size:10px;opacity:.8;margin-bottom:4px;">${Number(w.prize).toFixed(2)} Birr</div>
                    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:2px;">${cells}</div>
                    <div style="font-size:9px;opacity:.6;margin-top:3px;">Card #${w.cardNumber}</div>
                </div>`;
            }).join('');
            body.innerHTML = `
                <h3 style="margin:0 0 4px">Split ${winners.length} ways</h3>
                <p class="small" style="margin:0 0 12px">${g.patternName} · ${Number(g.prizePool).toFixed(2)} Birr total</p>
                <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:8px;">${cardsHtml}</div>`;
        }
    } catch (err) {
        console.error('History card fetch error:', err);
        body.innerHTML = '<p class="small">Could not load this card.</p>';
    }
}

function closeHistoryCardModal() {
    hide('historyCardModal');
}

// ---------------- WALLET ----------------
const WALLET_PAGE_SIZE = 20;
let walletOffset = 0, walletHasMore = true, walletLoading = false;

async function fetchWallet(username, reset = true) {
    if (!username) return;
    const list = document.getElementById('walletTransactions');
    if (!list) return;

    if (reset) {
        walletOffset = 0;
        walletHasMore = true;
        removeInfiniteScroll('walletSentinel');
        list.innerHTML = '<p class="small">Loading transactions…</p>';
    }
    if (!walletHasMore || walletLoading) return;
    walletLoading = true;

    try {
        const res = await fetch(`/api/wallet?username=${encodeURIComponent(username)}&limit=${WALLET_PAGE_SIZE}&offset=${walletOffset}`, { cache: 'no-store' });
        const data = await res.json();
        if (!data.success) return;

        const walletBalance = document.getElementById('walletBalanceDisplay');
        if (walletBalance) walletBalance.innerText = `${Number(data.balance).toFixed(2)} Birr`;

        renderWalletTransactions(data.transactions || [], reset);
        walletOffset += (data.transactions || []).length;
        walletHasMore = !!data.hasMore;
        if (walletHasMore) attachInfiniteScroll(list, 'walletSentinel', () => fetchWallet(username, false));
    } catch (err) {
        console.error('Wallet fetch error:', err);
    } finally {
        walletLoading = false;
    }
}

function renderWalletTransactions(transactions, reset = true) {
    const list = document.getElementById('walletTransactions');
    if (!list) return;

    if (reset) list.innerHTML = '';
    if (!transactions.length) {
        if (reset) list.innerHTML = '<p class="small">No transactions yet.</p>';
        return;
    }

    const html = transactions.map(tx => {
        const positive = tx.amount >= 0;
        const sign = positive ? '+' : '';
        return `<div class="tx-row">
            <div>
                <div class="tx-type">${formatTxType(tx.type)}</div>
                <div class="tx-date">${new Date(tx.date).toLocaleString()}</div>
            </div>
            <div class="tx-amount ${positive ? 'positive' : 'negative'}">${sign}${tx.amount.toFixed(2)} Birr</div>
        </div>`;
    }).join('');

    list.insertAdjacentHTML('beforeend', html);
}

function formatTxType(type) {
    const labels = {
        GAME_CARD_ENTRY: 'Card Entry',
        GAME_WIN: 'Game Win',
        WELCOME_BONUS: 'Welcome Bonus',
        CARD_DESELECT_REFUND: 'Card Refund',
        GAME_REFUND_UNREADY: 'Refund (Not Ready)',
        GAME_REFUND_NOT_ENOUGH_PLAYERS: 'Refund (Not Enough Players)',
        GAME_REFUND_LEFT_ROOM: 'Refund (Left Room)',
        GAME_REFUND_START_ERROR: 'Refund (Start Error)',
        DEPOSIT_APPROVED: 'Deposit',
        WITHDRAWAL_APPROVED: 'Withdrawal',
        WITHDRAWAL_REJECTED_REFUND: 'Withdrawal Refund',
        TRANSFER_SENT: 'Transfer Sent',
        TRANSFER_RECEIVED: 'Transfer Received',
        TRANSFER_REJECTED_REFUND: 'Transfer Refund',
        REFERRAL_BONUS: 'Referral Bonus',
        ADMIN_BONUS_ADJUSTMENT: 'Bonus Adjustment'
    };
    return labels[type] || type;
}

// ---------------- WALLET: DEPOSIT / WITHDRAW / TRANSFER ----------------
let cachedPaymentMethods = null;
let selectedDepositMethod = 'telebirr';
let selectedWithdrawMethod = 'telebirr';

function closeModal(id) { hide(id); }

function renderMethodInfo(container, method) {
    const list = (cachedPaymentMethods?.[method] || []);
    const rows = list.map(acc => `
        <div class="pay-account-row">
            <span>${acc.number} — ${acc.name}</span>
            <button class="pay-copy-btn" onclick="copyText('${acc.number}')">📋</button>
        </div>
    `).join('') || '<p class="small">No accounts configured yet.</p>';

    const steps = method === 'telebirr'
        ? `How to deposit via telebirr\n\nTo deposit via telebirr, please follow these steps:\n\nphone number    name`
        : `How to deposit via Commercial Bank\n\nTo deposit via bank transfer, please follow these steps:\n\naccount number    name`;

    container.innerHTML = `<div>${steps}</div>${rows}<div style="margin-top:10px;">1. Send the desired amount to one of the numbers above.\n2. After sending, forward the confirmation SMS below.\n\nImportant: make sure to forward the correct confirmation SMS.</div>`;
}

async function loadPaymentMethods() {
    if (cachedPaymentMethods) return cachedPaymentMethods;
    try {
        const res = await fetch('/api/payment-methods', { cache: 'no-store' });
        const data = await res.json();
        if (data.success) cachedPaymentMethods = data.methods;
    } catch (err) { console.error('Payment methods fetch error:', err); }
    return cachedPaymentMethods || { telebirr: [], cbe: [] };
}

async function openDepositModal() {
    await loadPaymentMethods();
    selectDepositMethod('telebirr');
    show('depositModal');
}

function selectDepositMethod(method) {
    selectedDepositMethod = method;
    document.getElementById('depositMethodTelebirr').classList.toggle('active', method === 'telebirr');
    document.getElementById('depositMethodCbe').classList.toggle('active', method === 'cbe');
    renderMethodInfo(document.getElementById('depositMethodInfo'), method);
}

function copyText(text) {
    navigator.clipboard?.writeText(text).then(
        () => showNotification('Copied: ' + text),
        () => {}
    );
}

async function submitDepositRequest() {
    const amount = Number(document.getElementById('depositAmount').value);
    const transactionId = document.getElementById('depositTransactionId').value.trim();
    const submittedText = document.getElementById('depositSubmittedText').value.trim();

    if (!Number.isFinite(amount) || amount <= 0) return alertUser('Enter the amount you sent.');
    if (!transactionId) return alertUser('Enter the transaction ID from your confirmation SMS.');

    try {
        const res = await fetch('/api/deposit-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUsername, method: selectedDepositMethod, amount, transactionId, submittedText })
        });
                const data = await res.json();
        if (!data.success) return showNotification(data.message || 'Could not submit deposit.');
        document.getElementById('depositAmount').value = '';
        document.getElementById('depositTransactionId').value = '';
        document.getElementById('depositSubmittedText').value = '';
        closeModal('depositModal');
        showNotification(data.autoVerified ? (data.message || 'Deposit verified and credited!') : 'Submitted — your deposit is pending review.');
        if (data.autoVerified) await loadUserData(currentUsername);
        fetchPendingRequests(currentUsername);
    } catch { alertUser('Could not submit deposit.'); }
}

function openWithdrawModal() {
    const balance = document.getElementById('balanceDisplay')?.innerText || '0.00';
    document.getElementById('withdrawBalanceDisplay').innerText = balance;
    selectWithdrawMethod('telebirr');
    show('withdrawModal');
}

function selectWithdrawMethod(method) {
    selectedWithdrawMethod = method;
    document.getElementById('withdrawMethodTelebirr').classList.toggle('active', method === 'telebirr');
    document.getElementById('withdrawMethodCbe').classList.toggle('active', method === 'cbe');
    const extra = document.getElementById('withdrawCbeExtra');
    const lbl = document.getElementById('withdrawDestLabel');
    if (extra) extra.classList.toggle('hidden', method !== 'cbe');
    if (lbl) lbl.innerText = method === 'cbe' ? 'CBE account number' : 'Destination number';
}

async function submitWithdrawRequest() {
    const amount = Number(document.getElementById('withdrawAmount').value);
    const destination = document.getElementById('withdrawDestination').value.trim();
    const accountOwnerName = document.getElementById('withdrawOwnerName')?.value.trim() || '';
    if (!destination) return alertUser('Enter the destination number.');
    if (selectedWithdrawMethod === 'cbe' && !accountOwnerName) return alertUser('Enter account owner name for CBE.');
    if (!Number.isFinite(amount) || amount < 21) return alertUser('Minimum withdrawal is 21 Birr.');

    try {
        const res = await fetch('/api/withdraw-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUsername, amount, method: selectedWithdrawMethod, destination, accountOwnerName: selectedWithdrawMethod === 'cbe' ? accountOwnerName : undefined })
        });
                const data = await res.json();
        if (!data.success) return showNotification(data.message || "You don't have enough balance to withdraw that amount.");
        document.getElementById('withdrawAmount').value = '';
        document.getElementById('withdrawDestination').value = '';
        if (document.getElementById('withdrawOwnerName')) document.getElementById('withdrawOwnerName').value = '';
        closeModal('withdrawModal');
        showNotification('Withdrawal submitted — pending review.');
        await loadUserData(currentUsername);
        fetchPendingRequests(currentUsername);
    } catch { alertUser('Could not submit withdrawal.'); }
}

function openTransferModal() {
    const balance = document.getElementById('balanceDisplay')?.innerText || '0.00';
    document.getElementById('transferBalanceDisplay').innerText = balance;
    show('transferModal');
}

async function submitTransferRequest() {
    const amount = Number(document.getElementById('transferAmount').value);
    const recipientPhone = document.getElementById('transferRecipient').value.trim();
    if (!recipientPhone) return alertUser('Enter the recipient phone number.');
    if (!Number.isFinite(amount) || amount <= 20) return alertUser('Transfers must be more than 20 Birr.');
    const ok = await confirmAction(`Confirm transfer of ${amount} Birr to ${recipientPhone}?`);
    if (!ok) return;

    try {
        const res = await fetch('/api/transfer-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUsername, amount, recipientPhone })
        });
                const data = await res.json();
        if (!data.success) return showNotification(data.message || 'Could not submit transfer.');
        document.getElementById('transferAmount').value = '';
        document.getElementById('transferRecipient').value = '';
        closeModal('transferModal');
        showNotification('Transfer submitted — pending review.');
        await loadUserData(currentUsername);
        fetchPendingRequests(currentUsername);
    } catch { alertUser('Could not submit transfer.'); }
}

async function fetchPendingRequests(username) {
    const card = document.getElementById('pendingRequestsCard');
    const list = document.getElementById('pendingRequestsList');
    if (!card || !list || !username) return;

    try {
        const res = await fetch(`/api/my-pending-requests?username=${encodeURIComponent(username)}`, { cache: 'no-store' });
        const data = await res.json();
        if (!data.success || !data.pending.length) { hide('pendingRequestsCard'); return; }

        show('pendingRequestsCard');
                list.innerHTML = data.pending.map(p => {
            const label = p.type === 'deposit' ? `Deposit ${Number(p.amount).toFixed(2)} Birr (${p.method})`
                : p.type === 'withdraw' ? `Withdraw ${Number(p.amount).toFixed(2)} Birr`
                : `Transfer ${Number(p.amount).toFixed(2)} Birr`;
            const when = new Date(p.created_at).toLocaleString();
            return `<div class="pending-row"><span>${label}<br><small>${when}</small></span><span class="pending-pill">Pending</span></div>`;
        }).join('');
    } catch (err) { console.error('Pending requests fetch error:', err); }
}

// ---------------- PROFILE ----------------
function toggleProfileModal() {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    modal.classList.toggle('hidden');
}

async function changeLanguage(language) {
    applyLanguage(language, true);
    if (!currentUsername) return;
    try {
        await fetch('/api/user/language', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUsername, language })
        });
    } catch (err) {
        console.error('Save language error:', err);
    }
}

// ---------------- LANGUAGE (EN / AM) ----------------
const translations = {
    en: {
        navGames: 'Games', navHistory: 'History', navWallet: 'Wallet', navAccount: 'Account',
        readyTitle: 'Ready to Play? 🎲', readyBody: 'Choose a stake, join a room, select your cards and play.', playBtn: 'Play Bingo 🚀',
        walletTitle: '💰 My Wallet', walletSub: 'Your current balance', walletTxTitle: 'Recent Transactions',
        historyTitle: '🏆 Game History',
        accountTitle: 'Account Settings ⚙️', accountBody: 'Set a password for website login (min 6 characters). Confirm password below.', accountSaveBtn: 'Save username & password 🔒', accountUsernameLabel: 'Username', accountUsernameHint: 'Keep this username or change it. Used for web login.', accountWebPasswordNote: 'Password can only be set or changed inside the Telegram Mini App for security.',
        profileTitle: '👤 Profile', profileUsernameLbl: 'USERNAME', profilePhoneLbl: 'PHONE', profileLangLbl: 'Language',
        announcementsTitle: '📢 Announcements'
    },
    am: {
        navGames: 'ጨዋታዎች', navHistory: 'ታሪክ', navWallet: 'ዋሌት', navAccount: 'መለያ',
        readyTitle: 'ለመጫወት ተዘጋጅተዋል? 🎲', readyBody: 'ውርርድ ይምረጡ፣ ክፍል ይቀላቀሉ፣ ካርድዎን ይምረጡ እና ይጫወቱ።', playBtn: 'ቢንጎ ይጫወቱ 🚀',
        walletTitle: '💰 የኔ ዋሌት', walletSub: 'የአሁኑ ቀሪ ሂሳብዎ', walletTxTitle: 'የቅርብ ጊዜ ግብይቶች',
        historyTitle: '🏆 የጨዋታ ታሪክ',
        accountTitle: 'የመለያ ቅንብሮች ⚙️', accountBody: 'ለድር መግቢያ የይለፍ ቃል ያዘጋጁ (ቢያንስ 6 ቁምፊ)። ከታች ያረጋግጡ።', accountSaveBtn: 'መጠቀሚያ ስም እና የይለፍ ቃል አስቀምጥ 🔒', accountUsernameLabel: 'መጠቀሚያ ስም', accountUsernameHint: 'ይህን መጠቀሚያ ስም ይጠብቁ ወይም ይቀይሩ። ለድር መግቢያ ያገለግላል።', accountWebPasswordNote: 'የይለፍ ቃል ማስተካከል የሚቻለው በቴሌግራም Mini App ውስጥ ብቻ ነው።',
        profileTitle: '👤 መገለጫ', profileUsernameLbl: 'የተጠቃሚ ስም', profilePhoneLbl: 'ስልክ', profileLangLbl: 'ቋንቋ',
        announcementsTitle: '📢 ማስታወቂያዎች'
    }
};

function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    safeStorage.set('bingoTheme', t);
}
async function changeTheme(theme) {
    applyTheme(theme);
    if (!currentUsername) return;
    try {
        await fetch('/api/user/theme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: currentUsername, theme }) });
    } catch {}
}
async function saveDisplayName() {
    const val = document.getElementById('displayNameInput')?.value.trim();
    if (!val || val.length < 2) return alertUser('Display name must be 2-50 chars.');
    try {
        const res = await fetch('/api/user/display-name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: currentUsername, displayName: val }) });
        const data = await res.json();
        if (!data.success) return alertUser(data.message || 'Failed');
        showNotification('Display name updated');
        await loadUserData(currentUsername);
    } catch { alertUser('Failed to save'); }
}
function applyLanguage(language, persistLocally = true) {
    const lang = translations[language] ? language : 'en';
    const t = translations[lang];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (t[key]) el.innerText = t[key];
    });

    if (persistLocally) safeStorage.set('bingoLang', lang);
}

function switchTab(tabId, navElement) {
    document.querySelectorAll('.tab-content').forEach(t => hide(t.id));
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    show(tabId);
    navElement?.classList.add('active');

    if (tabId === 'tabGames') {
        if (instantActive) {
            // Returning to Instant context — reconnect and resume live draw if needed
            connectInstantSocket();
            if (instantPhase === 'DRAWING' && document.getElementById('instantPlayBox')?.classList.contains('hidden')) {
                // stay on selection unless user was mid-draw and wants to re-open; openInstant already handles resume on entry
            }
        }
    } else if (!instantWatchOnly && typeof disconnectInstantSocket === 'function') {
        disconnectInstantSocket();
    }

    if (tabId === 'tabHistory') {
        if (instantActive) {
            renderInstantHistoryTab();
        } else {
            const title = document.querySelector('#tabHistory .page-title h2');
            if (title) title.textContent = '🏆 Game History';
            const list = document.getElementById('historyList');
            if (list) list.innerHTML = '';
            fetchHistory(currentUsername);
        }
    }
    if (tabId === 'tabWallet') { fetchWallet(currentUsername); fetchPendingRequests(currentUsername); }
    if (tabId === 'tabAccount') applyAccountTabForClient();
}

function logoutUser() {
    stopLobbyTimer();
    if (typeof disconnectInstantSocket === 'function') disconnectInstantSocket();
    if (notificationRefreshTimer) {
        clearInterval(notificationRefreshTimer);
        notificationRefreshTimer = null;
    }
    if (currentStake && currentRoom?.status !== 'PLAYING') {
        socket.emit('leave_room', { stake: currentStake, username: currentUsername });
    }
    clearWebSession();
    currentUsername = '';
    currentStake = null;
    currentRoom = null;
    showAuthBox();
}

async function setWebPassword() {
    if (!isTelegramClient()) {
        return alertUser('Password can only be set or changed inside the Telegram Mini App.');
    }
    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) {
        return alertUser('Telegram session missing. Close and reopen the Mini App, then try again.');
    }
    if (!currentUsername) return alertUser('Please log in first.');

    const usernameInput = document.getElementById('accountUsernameInput');
    const desiredUsername = (usernameInput?.value || currentUsername).trim();
    const newPassword = document.getElementById('webPasswordInput')?.value || '';
    const confirmPassword = document.getElementById('webPasswordConfirmInput')?.value || '';

    if (desiredUsername.length < 3 || desiredUsername.length > 30) {
        return alertUser('Username must be 3–30 characters.');
    }
    if (!/^[a-zA-Z0-9_]+$/.test(desiredUsername)) {
        return alertUser('Username may only contain letters, numbers, and underscores.');
    }
    if (newPassword.length < 6) {
        return alertUser('Password must be at least 6 characters.');
    }
    if (newPassword !== confirmPassword) {
        return alertUser('Passwords do not match. Please confirm your password.');
    }

    // Username change is bound to this Telegram account via initData (not the old username string).
    if (desiredUsername.toLowerCase() !== String(currentUsername).toLowerCase()) {
        try {
            const ur = await fetch('/api/user/username', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newUsername: desiredUsername, initData })
            });
            const ud = await ur.json();
            if (!ud.success) return alertUser(ud.message || 'Could not update username.');
            currentUsername = ud.username;
            safeStorage.set('bingoUser', currentUsername);
            touchWebSession();
            const pd = document.getElementById('playerDisplay');
            if (pd) pd.innerText = currentUsername;
            if (usernameInput) usernameInput.value = currentUsername;
        } catch {
            return alertUser('Could not update username.');
        }
    }

    try {
        const res = await fetch('/api/set-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword, initData })
        });
        const data = await res.json();
        alertUser(data.message || (data.success ? 'Password saved. You can log in on the website.' : 'Failed.'));
        if (data.success) {
            if (data.username) {
                currentUsername = data.username;
                safeStorage.set('bingoUser', currentUsername);
                touchWebSession();
            }
            const a = document.getElementById('webPasswordInput');
            const b = document.getElementById('webPasswordConfirmInput');
            if (a) a.value = '';
            if (b) b.value = '';
        }
    } catch {
        alertUser('Failed to save password.');
    }
}


function applyAccountTabForClient() {
    const pwSection = document.getElementById('webPasswordSection');
    const webNote = document.getElementById('webPasswordWebOnlyNote');
    const userInput = document.getElementById('accountUsernameInput');
    if (userInput && currentUsername) userInput.value = currentUsername;

    if (isTelegramClient()) {
        if (pwSection) pwSection.classList.remove('hidden');
        if (webNote) webNote.classList.add('hidden');
        if (userInput) userInput.disabled = false;
    } else {
        if (pwSection) pwSection.classList.add('hidden');
        if (webNote) webNote.classList.remove('hidden');
        // On web, username is view-only (change only in Telegram)
        if (userInput) {
            userInput.disabled = true;
            userInput.title = 'Change username in the Telegram Mini App';
        }
    }
}


// ---------------- TELEGRAM PHONE ----------------
function shareTelegramContact() {
    const tg = window.Telegram?.WebApp;
    if (!tg?.requestContact) return alert('Please update Telegram to support contact sharing.');
    tg.requestContact(async (sent, event) => {
        if (!sent) return alert('You must share your phone number to continue.');
        const phoneNumber = event?.responseUnsafe?.contact?.phone_number || event?.response?.contact?.phone_number;
        if (!phoneNumber) return alert('Could not retrieve your phone number.');
        await saveVerifiedTelegramPhone(phoneNumber);
    });
}

async function saveVerifiedTelegramPhone(phoneNumber) {
    const initData = window.Telegram?.WebApp?.initData;
    try {
        const res = await fetch('/api/save-telegram-phone',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData,phoneNumber})});
        const data = await res.json();
        if (!data.success) return alert(data.message || 'Failed to save phone.');
        hide('phoneModal');
        await showHomeScreen(currentUsername);
    } catch { alert('Network error while saving phone.'); }
}

// ---------------- NOTIFICATIONS ----------------
let cachedNotifications = [];

async function fetchNotifications(username) {
    if (!username) return;

    try {
        const res = await fetch(
            `/api/notifications?username=${encodeURIComponent(username)}`,
            { cache: 'no-store' }
        );
        const data = await res.json();
        if (!data.success) return;

        cachedNotifications = data.notifications || [];

        const unread = Number(data.unreadCount || 0);
        const badge = document.getElementById('notifBadge');

        if (badge) {
            badge.innerText = unread > 99 ? '99+' : unread;
            badge.classList.toggle('hidden', unread <= 0);
        }

        renderNotificationsList(cachedNotifications);
    } catch (err) {
        console.error('Notification error:', err);
    }
}
function renderNotificationsList(posts) {
    const container = document.getElementById('notifListContainer');
    if (!container) return;

    container.innerHTML = posts.length
        ? posts.map(post => `
            <div class="notif-card">
                ${post.image_url
                    ? `<img src="${post.image_url}" style="width:100%;border-radius:8px;margin-bottom:10px;display:block;" onerror="this.remove()">`
                    : ''}
                <div class="notif-body">${String(post.message || '').replace(/\n/g, '<br>')}</div>
                <div class="notif-date">${new Date(post.created_at).toLocaleString()}</div>
            </div>
        `).join('')
        : '<p class="small">No announcements yet.</p>';
}
async function markNotificationsAsRead() {
    if (!currentUsername) return;

    try {
        const res = await fetch('/api/notifications/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUsername })
        });

        const data = await res.json();
        if (!data.success) return;

        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.innerText = '0';
            badge.classList.add('hidden');
        }
    } catch (err) {
        console.error('Mark read error:', err);
    }
}

async function toggleNotificationModal() {
    const modal = document.getElementById('notifModal');
    if (!modal) return;

    const isOpening = modal.classList.contains('hidden');
    modal.classList.toggle('hidden');

    if (isOpening) {
        await fetchNotifications(currentUsername);
        await markNotificationsAsRead();
    }
}


// ==================== INSTANT BINGO (shared real-time rounds) ====================
let instantStake = 10;
let instantSelected = new Set();
let instantMaxCards = 4;
let instantSocket = null;
let instantSelectSeconds = 25;
let instantFakePlaying = 260;
let instantAudioCtx = null;
let instantLocked = false;
let instantJoined = false;
let instantMyCards = [];
let instantCalled = [];
let instantPhase = 'SELECTING';
let instantFakeOpponents = [];
let instantServerPlayers = [];
let instantGridsCache = {};
let instantActive = false; // true while Instant UI is the active context
let instantOppRenderToken = 0;
let instantWatchOnly = false; // left draw screen but round still running

function setInstantImmersive(on) {
    document.body.classList.toggle('instant-immersive', !!on);
    // Keep bottom nav available so users can open History (Instant leaders/history) even during a live draw
    if (on) { hide('headerBar'); if (currentUsername) show('bottomNav'); }
    else if (currentUsername) { show('headerBar'); show('bottomNav'); }
}

function showInstantHelp() { show('instantHelpModal'); }

function renderInstantStakePills(stakes) {
    const row = document.getElementById('instantStakeRow');
    if (!row) return;
    row.innerHTML = (stakes || []).map(function (s) {
        const active = Number(s) === Number(instantStake) ? ' active' : '';
        return '<button type="button" class="instant-stake-pill' + active + '" data-stake="' + s +
            '" onclick="selectInstantStake(' + s + ')">' + s + '</button>';
    }).join('');
}
function selectInstantStake(s) {
    if (instantLocked || instantJoined) return;
    instantStake = Number(s);
    document.querySelectorAll('.instant-stake-pill').forEach(function (b) {
        b.classList.toggle('active', Number(b.getAttribute('data-stake')) === instantStake);
    });
    updateInstantCost();
}
window.selectInstantStake = selectInstantStake;

function switchInstantPanel(panel) {
    // Panels removed from Instant selection; History tab shows Instant history + leaderboard while Instant is active.
}
window.switchInstantPanel = switchInstantPanel;


window.showInstantHelp = showInstantHelp;

function instantBeep() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!instantAudioCtx) instantAudioCtx = new Ctx();
        if (instantAudioCtx.state === 'suspended') instantAudioCtx.resume().catch(function () {});
        const o = instantAudioCtx.createOscillator();
        const g = instantAudioCtx.createGain();
        o.frequency.value = 880;
        o.connect(g); g.connect(instantAudioCtx.destination);
        const t = instantAudioCtx.currentTime;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
        o.start(t); o.stop(t + 0.11);
    } catch (_) {}
}

function leaveInstantSelection() {
    instantLocked = false;
    instantJoined = false;
    instantActive = false;
    instantWatchOnly = false;
    hide('instantWaitOverlay');
    hide('instantBox');
    hide('instantPlayBox');
    setInstantImmersive(false);
    disconnectInstantSocket();
    show('homeBox');
}
window.leaveInstantSelection = leaveInstantSelection;

function leaveInstantPlay() {
    // Allow leaving even while drawing — user can return later and resume the live view
    hide('instantPlayBox');
    setInstantImmersive(false);
    show('instantBox');
    if (instantPhase === 'DRAWING') {
        instantWatchOnly = true;
        // keep socket connected so we can re-enter the live draw
    } else {
        instantLocked = false;
        instantWatchOnly = false;
        const btn = document.getElementById('instantJoinBtn');
        if (btn) btn.disabled = false;
    }
}
window.leaveInstantPlay = leaveInstantPlay;

async function openInstantBingo() {
    if (!currentUsername) return alertUser('Please log in first.');
    const tab = document.getElementById('tabGames');
    if (tab) tab.classList.remove('hidden');
    document.querySelectorAll('.tab-content').forEach(function (el) {
        if (el.id !== 'tabGames') el.classList.add('hidden');
    });
    hide('homeBox'); hide('roomsBox'); hide('selectionBox'); hide('gamePlayBox'); hide('instantPlayBox');
    setInstantImmersive(false);
    show('instantBox');
    instantActive = true;
    instantSelected.clear();
    instantJoined = false;
    instantLocked = false;
    instantWatchOnly = false;
    updateInstantSelectedDisplay();
    hide('instantWaitOverlay');
    const status = await loadInstantUI();
    connectInstantSocket();

    // Rejoin live draw if a shared round is already in progress (paid or watch).
    if (status && status.phase === 'DRAWING') {
        const me = (status.players || []).find(function (p) {
            return String(p.realUsername || '').toLowerCase() === String(currentUsername || '').toLowerCase();
        });
        instantServerPlayers = status.players || [];
        instantFakeOpponents = status.fakeOpponents || [];
        if (me) {
            instantJoined = true;
            instantLocked = true;
            instantMyCards = me.cards || [];
        } else {
            instantMyCards = [];
            instantWatchOnly = true;
        }
        const totalNumbers = Number(status.numbersDrawn || 20);
        const known = status.drawnNumbers || [];
        const padded = known.concat(new Array(Math.max(0, totalNumbers - known.length)).fill(0));
        openSharedDrawScreen({ drawnNumbers: padded, resume: true, drawIndex: status.drawIndex || known.length });
    }
}
window.openInstantBingo = openInstantBingo;

function applyInstantState(st) {
    if (!st) return;
    const prevPhase = instantPhase;
    instantPhase = st.phase || 'SELECTING';
    instantSelectSeconds = st.selectionSeconds || 25;
    instantMaxCards = st.maxCardsPerPlayer || 4;
    if (st.playing) setInstantPlayingDisplay(st.playing);
    instantFakeOpponents = st.fakeOpponents || [];
    instantServerPlayers = st.players || [];

    const el = document.getElementById('instantSelectTimer');
    if (el && st.phase === 'SELECTING') {
        el.textContent = String(st.secondsLeft != null ? st.secondsLeft : '—');
        el.style.background = 'transparent';
        el.style.color = '';
        el.style.fontWeight = st.secondsLeft <= 5 ? '800' : '700';
    }

    if (st.phase === 'SELECTING') {
        // New selection round — clear previous picks once
        if (prevPhase !== 'SELECTING') {
            instantSelected.clear();
            instantMyCards = [];
            instantJoined = false;
            instantLocked = false;
            instantWatchOnly = false;
            _lastOppSignature = '';
            updateInstantCost();
            updateInstantSelectedDisplay();
            const btn = document.getElementById('instantJoinBtn');
            if (btn) btn.disabled = false;
        }
        // If still on play screen, return to selection
        if (document.getElementById('instantPlayBox') && !document.getElementById('instantPlayBox').classList.contains('hidden')) {
            leaveInstantPlay();
        }
        renderInstantOpponents();
    }
}

function setInstantPlayingDisplay(n) {
    n = Math.max(200, Math.min(400, Number(n) || 260));
    instantFakePlaying = n;
    const text = '🟢 LIVE · Playing | ' + n;
    ['instantPlayingPill', 'instantPlayPlaying'].forEach(function (id) {
        const a = document.getElementById(id);
        if (a) a.textContent = text;
    });
}

async function loadInstantUI() {
    const msg = document.getElementById('instantMsg');
    try {
        const res = await fetch('/api/instant/status?_=' + Date.now(), { cache: 'no-store' });
        const data = await res.json();
        if (!data.success || data.enabled === false) {
            if (msg) msg.textContent = data.message || 'Disabled.';
            return;
        }
        applyInstantState(data);
        const stakes = data.stakes || [10, 20, 50, 100, 200, 500];
        if (!stakes.includes(Number(instantStake))) instantStake = stakes[0];
        renderInstantStakePills(stakes);
        await renderInstantCards();
        updateInstantCost();
        renderInstantOpponents();
        if (msg) msg.textContent = '';
        return data;
    } catch (e) {
        if (msg) msg.textContent = 'Could not load Instant.';
        return null;
    }
}

async function renderInstantCards() {
    const grid = document.getElementById('instantCardGrid');
    if (!grid) return;
    try {
        const res = await fetch('/api/instant/cards?_=' + Date.now(), { cache: 'no-store' });
        const data = await res.json();
        if (!data.success) {
            grid.innerHTML = '<p class="small">No cards</p>';
            return;
        }
        grid.innerHTML = (data.cards || []).map(function (n) {
            return '<div class="card-item' + (instantSelected.has(n) ? ' selected' : '') +
                '" data-card="' + n + '" onclick="toggleInstantCard(' + n + ')">' + n + '</div>';
        }).join('');
    } catch (_) {
        grid.innerHTML = '<p class="small">Failed</p>';
    }
}

async function fetchInstantGrid(num) {
    if (instantGridsCache[num]) return instantGridsCache[num];
    try {
        const res = await fetch('/api/instant/card/' + num + '?_=' + Date.now(), { cache: 'no-store' });
        const data = await res.json();
        if (data.success && data.grid) {
            instantGridsCache[num] = data.grid;
            return data.grid;
        }
    } catch (_) {}
    return null;
}

async function showInstantCardPreview(n) {
    const box = document.getElementById('instantCardPreview');
    if (!box) return;
    const grid = await fetchInstantGrid(n);
    if (!grid) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="small" style="margin-bottom:4px;">Card #' + n + '</div>' +
        renderInstantGridHtml(grid, [], [], 'prev' + n);
}

function toggleInstantCard(n) {
    if (instantLocked || instantJoined) return;
    n = Number(n);
    if (instantSelected.has(n)) {
        instantSelected.delete(n);
    } else {
        if (instantSelected.size >= instantMaxCards) return alertUser('Max ' + instantMaxCards + ' cards');
        instantSelected.add(n);
    }
    document.querySelectorAll('#instantCardGrid .card-item').forEach(function (el) {
        el.classList.toggle('selected', instantSelected.has(Number(el.getAttribute('data-card'))));
    });
    updateInstantCost();
    updateInstantSelectedDisplay();
}
window.toggleInstantCard = toggleInstantCard;

function removeInstantSelected(n) {
    if (instantLocked || instantJoined) return;
    n = Number(n);
    instantSelected.delete(n);
    document.querySelectorAll('#instantCardGrid .card-item').forEach(function (el) {
        el.classList.toggle('selected', instantSelected.has(Number(el.getAttribute('data-card'))));
    });
    updateInstantCost();
    updateInstantSelectedDisplay();
}
window.removeInstantSelected = removeInstantSelected;

async function updateInstantSelectedDisplay() {
    const box = document.getElementById('instantSelectedCards');
    if (!box) return;
    const nums = Array.from(instantSelected);
    if (!nums.length) {
        box.innerHTML = '';
        return;
    }
    const parts = [];
    for (let i = 0; i < nums.length; i++) {
        const n = nums[i];
        const g = await fetchInstantGrid(n);
        const gridHtml = g ? renderInstantGridHtml(g, [], [], 'sel' + n) : '';
        parts.push(
            '<div class="instant-selected-item">' +
            '<button type="button" class="sel-remove" onclick="removeInstantSelected(' + n + ')" title="Remove">×</button>' +
            '<div class="sel-label">#' + n + '</div>' + gridHtml + '</div>'
        );
    }
    box.innerHTML = parts.join('');
}

function pickRandomInstantCards(count) {
    if (instantLocked || instantJoined) return;
    count = Math.min(Number(count) || 2, instantMaxCards);
    const items = Array.from(document.querySelectorAll('#instantCardGrid .card-item'));
    const available = items.map(function (el) { return Number(el.getAttribute('data-card')); }).filter(function (n) { return n && !instantSelected.has(n); });
    // shuffle
    for (let i = available.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = available[i]; available[i] = available[j]; available[j] = t;
    }
    const need = Math.max(0, count - instantSelected.size);
    for (let k = 0; k < need && k < available.length; k++) {
        instantSelected.add(available[k]);
    }
    // if already had some, still ensure we reach `count` by adding more if possible
    while (instantSelected.size < count && available.length) {
        const n = available.shift();
        if (n && !instantSelected.has(n)) instantSelected.add(n);
        else break;
    }
    document.querySelectorAll('#instantCardGrid .card-item').forEach(function (el) {
        el.classList.toggle('selected', instantSelected.has(Number(el.getAttribute('data-card'))));
    });
    updateInstantCost();
    updateInstantSelectedDisplay();
}
window.pickRandomInstantCards = pickRandomInstantCards;

function updateInstantCost() {
    const stake = Number(instantStake || 0);
    const costEl = document.getElementById('instantCost');
    const countEl = document.getElementById('instantSelectedCount');
    if (costEl) costEl.textContent = String(stake * instantSelected.size);
    if (countEl) countEl.textContent = instantSelected.size + '/' + instantMaxCards;
}

let _lastOppSignature = '';
async function renderInstantOpponents() {
    const box = document.getElementById('instantOpponents');
    if (!box) return;
    // Expand real players to one slot per card, then fill with fakes
    const slots = [];
    (instantServerPlayers || []).forEach(function (p) {
        const cards = Array.isArray(p.cards) && p.cards.length ? p.cards : (p.cardNumber != null ? [p.cardNumber] : []);
        cards.forEach(function (cn) {
            slots.push({ username: p.username, cardNumber: cn, stake: p.stake, fake: false });
        });
    });
    (instantFakeOpponents || []).forEach(function (p) {
        slots.push({
            username: p.username,
            cardNumber: p.cardNumber != null ? p.cardNumber : (Array.isArray(p.cards) ? p.cards[0] : null),
            stake: p.stake,
            fake: true
        });
    });
    const list = slots.slice(0, 14);
    const signature = list.map(function (s) { return s.username + ':' + s.cardNumber; }).join('|');
    // Avoid restarting the staggered animation on every 250ms state tick
    if (signature === _lastOppSignature && box.children.length > 0) return;
    _lastOppSignature = signature;

    if (!list.length) {
        box.innerHTML = '<p class="small" style="opacity:.6;">Waiting for players…</p>';
        return;
    }
    const token = ++instantOppRenderToken;
    box.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
        if (token !== instantOppRenderToken) return;
        const p = list[i];
        const cardN = p.cardNumber;
        const g = cardN ? await fetchInstantGrid(cardN) : null;
        // Unselected during selection (no called marks)
        const gridHtml = g ? renderInstantGridHtml(g, [], [], 'opp' + i) : '';
        const el = document.createElement('div');
        el.className = 'instant-opp';
        const stakeLabel = (p.stake != null ? p.stake : '');
        el.innerHTML =
            '<div class="opp-meta"><div class="opp-name">' + escapeHtmlInstant(p.username) + '</div>' +
            '<div style="opacity:.75;">#' + (cardN || '—') + (stakeLabel !== '' ? (' · 💰' + stakeLabel) : '') + '</div></div>' +
            '<div class="opp-card-wrap">' + gridHtml + '</div>';
        box.appendChild(el);
        await new Promise(function (r) { setTimeout(r, i === 0 ? 40 : 1000); });
        if (token !== instantOppRenderToken) return;
        el.classList.add('visible');
    }
}


async function startInstantPlay() {
    try {
        if (instantAudioCtx && instantAudioCtx.state === 'suspended') instantAudioCtx.resume().catch(function () {});
        else instantBeep();
    } catch (_) {}
    if (!currentUsername) return alertUser('Log in first.');
    if (instantPhase !== 'SELECTING') return alertUser('Wait for next selection.');
    if (!instantSelected.size) return alertUser('Select at least one card.');
    const stake = Number(instantStake || 0);
    const cardNumbers = Array.from(instantSelected);
    const btn = document.getElementById('instantJoinBtn');
    if (btn) btn.disabled = true;
    const msg = document.getElementById('instantMsg');
    if (msg) msg.textContent = 'Joining shared round…';
    try {
        const res = await fetch('/api/instant/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUsername, stake: stake, cardNumbers: cardNumbers })
        });
        const data = await res.json();
        if (!data.success) {
            if (btn) btn.disabled = false;
            if (msg) msg.textContent = data.message || 'Failed';
            alertUser(data.message || 'Failed');
            return;
        }
        instantJoined = true;
        instantLocked = true;
        instantMyCards = cardNumbers;
        document.querySelectorAll('#userBalance, #walletBalance, #headerBalance, #playerBalance').forEach(function (el) {
            if (el && data.balance != null) el.textContent = Number(data.balance).toFixed(2);
        });
        show('instantWaitOverlay');
        const title = document.getElementById('instantWaitTitle');
        const waitText = document.getElementById('instantWaitText');
        if (title) title.textContent = 'In this round · ' + cardNumbers.length + ' card(s)';
        if (waitText) waitText.textContent = 'Waiting for shared draw (timer)…';
        if (msg) msg.textContent = 'Joined — same numbers for everyone.';
        if (data.state) applyInstantState(data.state);
    } catch (e) {
        if (btn) btn.disabled = false;
        if (msg) msg.textContent = 'Network error';
    }
}
window.startInstantPlay = startInstantPlay;
window.joinInstantRound = startInstantPlay;

function startInstantWatch() { /* removed — auto-sync via shared round */ }
window.startInstantWatch = startInstantWatch;

function openSharedDrawScreen(payload) {
    // Defense in depth: the socket that drives this is only ever supposed to
    // be connected while the Instant Bingo screen is the active screen (see
    // disconnectInstantSocket / where it's called from below). But belt and
    // braces — never let the shared draw render on top of whatever else is
    // on screen; always claim the whole "games" area for itself first.
    hide('homeBox');
    hide('roomsBox');
    hide('selectionBox');
    hide('gamePlayBox');
    hide('instantBox');
    hide('instantWaitOverlay');
    show('instantPlayBox');
    setInstantImmersive(true);
    instantCalled = [];
    instantBestWins = {};
    // 20 fixed ball slots
    const balls = document.getElementById('instantCalledBalls');
    if (balls) {
        let slots = '';
        for (let i = 0; i < 20; i++) slots += '<div class="ball-slot" data-slot="' + i + '"></div>';
        balls.innerHTML = slots;
    }
    const lastEl = document.getElementById('instantLastNumber');
    if (lastEl) lastEl.textContent = '—';
    const totalN = ((payload && payload.drawnNumbers) || []).length || 20;
    const prog = document.getElementById('instantDrawProgress');
    if (prog) prog.textContent = '0/' + totalN;
    const status = document.getElementById('instantPlayStatus');
    if (status) status.textContent = 'Live draw';
    const backBtn = document.getElementById('instantPlayBackBtn');
    if (backBtn) backBtn.disabled = false; // always allow leave

    const live = document.getElementById('instantLiveCards');
    if (!live) return;
    live.innerHTML = '<p class="small">Loading…</p>';
    (async function () {
        const myBlocks = [];
        for (let i = 0; i < instantMyCards.length; i++) {
            const n = instantMyCards[i];
            const g = await fetchInstantGrid(n);
            myBlocks.push('<div class="instant-card-wrap"><div style="font-size:10px;margin-bottom:4px;"><b>You · #' + n + '</b></div>' +
                renderInstantGridHtml(g, [], [], 'myc' + i) + '</div>');
        }
        // Expand others: real players' cards first, then fakes
        const otherSlots = [];
        (instantServerPlayers || []).forEach(function (p) {
            if (p.realUsername && p.realUsername.toLowerCase() === String(currentUsername || '').toLowerCase()) return;
            const cards = Array.isArray(p.cards) && p.cards.length ? p.cards : (p.cardNumber != null ? [p.cardNumber] : []);
            cards.forEach(function (cn) {
                otherSlots.push({ username: p.username, cardNumber: cn, stake: p.stake });
            });
        });
        (instantFakeOpponents || []).forEach(function (p) {
            otherSlots.push({
                username: p.username,
                cardNumber: p.cardNumber != null ? p.cardNumber : (Array.isArray(p.cards) ? p.cards[0] : null),
                stake: p.stake
            });
        });
        const others = otherSlots.slice(0, 12);
        const otherRows = [];
        for (let i = 0; i < others.length; i++) {
            const p = others[i];
            const cn = p.cardNumber;
            const g = await fetchInstantGrid(cn);
            const st = (p.stake != null ? (' · 💰' + p.stake) : '');
            otherRows.push(
                '<div class="instant-card-wrap" style="padding:6px 8px;">' +
                '<div style="font-size:10px;text-align:left;"><b>' + escapeHtmlInstant(p.username) + '</b><br><span style="opacity:.75;">#' + cn + st + '</span></div>' +
                (g ? renderInstantGridHtml(g, [], [], 'otc' + i) : '') + '</div>'
            );
        }
        live.innerHTML =
            (myBlocks.length
                ? '<div style="font-size:11px;font-weight:700;margin-bottom:4px;opacity:.85;">Your cards</div><div class="instant-cards-row">' + myBlocks.join('') + '</div>'
                : '<p class="small" style="opacity:.7;">Watching this round</p>') +
            '<div style="margin-top:10px;font-size:11px;font-weight:700;opacity:.8;">Other players</div>' +
            '<div class="instant-others-grid">' + otherRows.join('') + '</div>';
        if (payload && payload.resume && payload.drawIndex) {
            const called = (payload.drawnNumbers || []).slice(0, payload.drawIndex);
            called.forEach(function (num, idx2) {
                applyCalledNumber(num, idx2 + 1, (payload.drawnNumbers || []).length || 20, called.slice(0, idx2 + 1), true);
            });
        }
    })();
}


function shootNumberToBalls(num, slotIndex, skipAnim) {
    const balls = document.getElementById('instantCalledBalls');
    const lastEl = document.getElementById('instantLastNumber');
    if (lastEl) lastEl.textContent = String(num);

    const slot = balls ? balls.querySelector('.ball-slot[data-slot="' + slotIndex + '"]') : null;
    if (!slot) return;

    if (skipAnim) {
        slot.textContent = String(num);
        slot.classList.add('filled');
        return;
    }

    // Start from the orange last-number display
    const fromRect = lastEl ? lastEl.getBoundingClientRect() : { left: window.innerWidth / 2, top: 80, width: 40, height: 40 };
    const toRect = slot.getBoundingClientRect();

    const fly = document.createElement('div');
    fly.className = 'instant-shoot';
    fly.textContent = String(num);
    const startX = fromRect.left + fromRect.width / 2 - 24;
    const startY = fromRect.top + fromRect.height / 2 - 24;
    fly.style.left = startX + 'px';
    fly.style.top = startY + 'px';
    fly.style.transform = 'scale(1.15)';
    document.body.appendChild(fly);

    const endX = toRect.left + toRect.width / 2 - 24;
    const endY = toRect.top + toRect.height / 2 - 24;
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            fly.style.transform = 'translate(' + (endX - startX) + 'px,' + (endY - startY) + 'px) scale(0.45)';
            fly.style.opacity = '0.2';
        });
    });
    setTimeout(function () {
        try { fly.remove(); } catch (_) {}
        slot.textContent = String(num);
        slot.classList.add('filled');
    }, 520);
}


// Client-side Instant win rules (mirrors src/game/instant/patterns.js)
const INSTANT_ROWS = [
  [[0,0],[0,1],[0,2],[0,3],[0,4]],[[1,0],[1,1],[1,2],[1,3],[1,4]],[[2,0],[2,1],[2,2],[2,3],[2,4]],
  [[3,0],[3,1],[3,2],[3,3],[3,4]],[[4,0],[4,1],[4,2],[4,3],[4,4]]
];
const INSTANT_COLS = [
  [[0,0],[1,0],[2,0],[3,0],[4,0]],[[0,1],[1,1],[2,1],[3,1],[4,1]],[[0,2],[1,2],[2,2],[3,2],[4,2]],
  [[0,3],[1,3],[2,3],[3,3],[4,3]],[[0,4],[1,4],[2,4],[3,4],[4,4]]
];
const INSTANT_DIAGS = [
  [[0,0],[1,1],[2,2],[3,3],[4,4]],[[0,4],[1,3],[2,2],[3,1],[4,0]]
];
const INSTANT_CORNERS = [[0,0],[0,4],[4,0],[4,4]];
let instantBestWins = {}; // cardNumber -> { multiplier, winningCells, pattern }

function instantCellMatched(grid, r, c, drawnSet) {
  const v = grid[r][c];
  if (v === 'FREE' || v === 0 || (r === 2 && c === 2)) return true;
  return drawnSet.has(Number(v));
}
function instantLineComplete(grid, drawnSet, cells) {
  return cells.every(function (p) { return instantCellMatched(grid, p[0], p[1], drawnSet); });
}
function evaluateInstantCard(grid, drawnNumbers) {
  const drawnSet = new Set((drawnNumbers || []).map(Number));
  if (!grid || !grid.length) return { hit: false, pattern: null, multiplier: 0, winningCells: [] };
  const completedRows = INSTANT_ROWS.filter(function (line) { return instantLineComplete(grid, drawnSet, line); });
  const completedCols = INSTANT_COLS.filter(function (line) { return instantLineComplete(grid, drawnSet, line); });
  const completedDiags = INSTANT_DIAGS.filter(function (line) { return instantLineComplete(grid, drawnSet, line); });
  const rowColCount = completedRows.length + completedCols.length;
  const hasCorners = instantLineComplete(grid, drawnSet, INSTANT_CORNERS);
  const hasDiag = completedDiags.length > 0;
  const hasRowOrCol = rowColCount > 0;
  const candidates = [];
  if (hasCorners && (hasRowOrCol || hasDiag)) {
    const extra = hasRowOrCol ? (completedRows[0] || completedCols[0]) : completedDiags[0];
    const cells = INSTANT_CORNERS.concat(extra || []);
    const seen = new Set(); const uniq = [];
    cells.forEach(function (p) { const k = p[0] + ',' + p[1]; if (!seen.has(k)) { seen.add(k); uniq.push(p); } });
    candidates.push({ pattern: 'corners_plus_line', multiplier: 4, winningCells: uniq });
  }
  if (hasCorners) {
    candidates.push({ pattern: 'four_corners', multiplier: 2.5, winningCells: INSTANT_CORNERS.map(function (p) { return [p[0], p[1]]; }) });
  }
  if (hasDiag) {
    candidates.push({ pattern: 'diagonal', multiplier: 1.5, winningCells: completedDiags[0].map(function (p) { return [p[0], p[1]]; }) });
  }
  if (rowColCount >= 2) {
    const lines = completedRows.concat(completedCols).slice(0, 2);
    const cells = []; const seen = new Set();
    lines.forEach(function (line) {
      line.forEach(function (p) { const k = p[0] + ',' + p[1]; if (!seen.has(k)) { seen.add(k); cells.push(p); } });
    });
    candidates.push({ pattern: 'two_lines', multiplier: 2, winningCells: cells });
  } else if (rowColCount === 1) {
    const line = completedRows[0] || completedCols[0];
    candidates.push({ pattern: 'one_line', multiplier: 1, winningCells: line.map(function (p) { return [p[0], p[1]]; }) });
  }
  if (!candidates.length) return { hit: false, pattern: null, multiplier: 0, winningCells: [] };
  candidates.sort(function (a, b) { return b.multiplier - a.multiplier; });
  const best = candidates[0];
  return { hit: true, pattern: best.pattern, multiplier: best.multiplier, winningCells: best.winningCells };
}

function applyWinStrikeToTable(table, winningCells) {
  if (!table) return;
  // clear previous win marks on this table only (keep marked numbers)
  table.querySelectorAll('td.win-line, td.strike').forEach(function (td) {
    td.classList.remove('win-line', 'strike');
    if (!td.classList.contains('marked') && td.textContent.trim() === '★') td.classList.add('marked');
  });
  (winningCells || []).forEach(function (cell) {
    const rr = cell[0], cc = cell[1];
    const td = table.querySelector('td[data-r="' + rr + '"][data-c="' + cc + '"]');
    if (td) td.className = 'win-line strike';
  });
}

async function checkMyInstantWinsLive() {
  if (!instantMyCards || !instantMyCards.length) return;
  for (let i = 0; i < instantMyCards.length; i++) {
    const n = instantMyCards[i];
    const grid = await fetchInstantGrid(n);
    if (!grid) continue;
    const result = evaluateInstantCard(grid, instantCalled);
    const prev = instantBestWins[n];
    if (result.hit && (!prev || result.multiplier > prev.multiplier)) {
      instantBestWins[n] = { multiplier: result.multiplier, winningCells: result.winningCells, pattern: result.pattern };
      // find this card's table(s) on play screen
      document.querySelectorAll('#instantLiveCards table.instant-bingo-table').forEach(function (table) {
        // match by nearby label containing #n
        const wrap = table.closest('.instant-card-wrap');
        if (!wrap) return;
        const label = wrap.textContent || '';
        if (label.indexOf('#' + n) !== -1 || table.id.indexOf('myc') === 0) {
          // prefer exact: tables rendered as myc0, myc1 in order of instantMyCards
        }
      });
      // Prefer ordered my tables: id prefix myc + index
      const table = document.getElementById('myc' + i) || document.querySelector('#instantLiveCards table#myc' + i);
      if (table) applyWinStrikeToTable(table, result.winningCells);
      else {
        // fallback: any my card wrap with this number
        document.querySelectorAll('#instantLiveCards .instant-card-wrap').forEach(function (wrap) {
          if ((wrap.textContent || '').indexOf('#' + n) !== -1) {
            const t = wrap.querySelector('table.instant-bingo-table');
            if (t) applyWinStrikeToTable(t, result.winningCells);
          }
        });
      }
    }
  }
}

function applyCalledNumber(num, index, total, calledArr, skipAnim) {
    instantCalled = calledArr || instantCalled.concat([num]);
    if (!skipAnim) instantBeep();
    const slotIndex = Math.max(0, (index || instantCalled.length) - 1);
    shootNumberToBalls(num, slotIndex, !!skipAnim);
    const prog = document.getElementById('instantDrawProgress');
    if (prog) prog.textContent = index + '/' + total;
    const status = document.getElementById('instantPlayStatus');
    if (status) status.textContent = String(num);

    // highlight all tables on play screen
    document.querySelectorAll('#instantLiveCards table.instant-bingo-table').forEach(function (table) {
        table.querySelectorAll('td').forEach(function (td) {
            const t = td.textContent.trim();
            if (t === '★') {
                td.classList.add('marked');
                return;
            }
            if (Number(t) === Number(num) || instantCalled.map(Number).includes(Number(t))) {
                td.classList.add('marked');
            }
        });
    });
    // Real-time win strike (upgrade if a better pattern appears later)
    if (!skipAnim) {
        checkMyInstantWinsLive().catch(function () {});
    } else {
        // resume path — still evaluate after batch
        checkMyInstantWinsLive().catch(function () {});
    }
}

// The server runs Instant Bingo as one continuous shared round (a new draw
// starts automatically every ~45-70s, whether anyone is watching or not).
// The socket below must only be connected while the Instant Bingo screen is
// the thing actually on screen — otherwise a round starting in the
// background pops the live-draw screen over whatever you're doing (home,
// classic bingo, wallet, etc). Every place that navigates away from Instant
// Bingo calls this first.
function disconnectInstantSocket() {
    if (instantSocket && instantSocket.connected) {
        try { instantSocket.disconnect(); } catch (_) {}
    }
}
window.disconnectInstantSocket = disconnectInstantSocket;

function connectInstantSocket() {
    if (typeof io === 'undefined') return;
    try {
        if (!instantSocket) {
            instantSocket = io('/instant', { transports: ['websocket', 'polling'], forceNew: false });
            instantSocket.on('connect', function () {
                instantSocket.emit('instant_sync');
            });
            instantSocket.on('instant_state', function (st) {
                applyInstantState(st);
            });
            instantSocket.on('instant_players', function (p) {
                if (p && p.playing != null) setInstantPlayingDisplay(p.playing);
            });
            instantSocket.on('instant_draw_start', function (payload) {
                instantPhase = 'DRAWING';
                instantCalled = [];
                if (payload && payload.players) instantServerPlayers = payload.players;
                if (payload && payload.fakeOpponents) instantFakeOpponents = payload.fakeOpponents;
                openSharedDrawScreen(payload || {});
            });
            instantSocket.on('instant_number', function (p) {
                // If user left the play screen but round is still live, keep selection UI;
                // when they open Instant again they'll resume. Don't force-pop the draw.
                const playHidden = document.getElementById('instantPlayBox')?.classList.contains('hidden');
                if (playHidden && !instantWatchOnly) {
                    // still on selection / elsewhere — ignore visual
                } else if (playHidden && instantWatchOnly) {
                    // user navigated away intentionally; do nothing until they re-open
                } else {
                    if (playHidden) {
                        openSharedDrawScreen({ drawnNumbers: p.called, resume: true, drawIndex: p.index });
                    }
                    applyCalledNumber(p.number, p.index, p.total, p.called);
                }
                if (p.playing) setInstantPlayingDisplay(p.playing);
            });
            instantSocket.on('instant_draw_end', function (payload) {
                // Strike only the specific card that won — never paint the pattern onto every card
                const results = (payload && payload.results) || [];
                results.forEach(function (r) {
                    if (String(r.username).toLowerCase() !== String(currentUsername || '').toLowerCase()) return;
                    if (!r.hit && !(Number(r.prize) > 0)) return;
                    const cardNum = Number(r.cardNumber);
                    const myIndex = (instantMyCards || []).indexOf(cardNum);
                    let table = myIndex >= 0 ? document.getElementById('myc' + myIndex) : null;
                    if (!table) {
                        document.querySelectorAll('#instantLiveCards .instant-card-wrap').forEach(function (wrap) {
                            if (table) return;
                            if ((wrap.textContent || '').indexOf('#' + cardNum) !== -1) {
                                table = wrap.querySelector('table.instant-bingo-table');
                            }
                        });
                    }
                    if (!table) return;
                    if (typeof applyWinStrikeToTable === 'function') {
                        applyWinStrikeToTable(table, r.winningCells || []);
                    } else {
                        (r.winningCells || []).forEach(function (cell) {
                            const rr = cell[0], cc = cell[1];
                            const td = table.querySelector('td[data-r="' + rr + '"][data-c="' + cc + '"]');
                            if (td) td.className = 'win-line strike';
                        });
                    }
                });
                const status = document.getElementById('instantPlayStatus');
                if (status) status.textContent = 'Round over — next selection…';
                const backBtn = document.getElementById('instantPlayBackBtn');
                if (backBtn) backBtn.disabled = false;
                if (typeof loadUserData === 'function' && currentUsername) {
                    try { loadUserData(currentUsername); } catch (_) {}
                }
                // Clear previous selection for the new round
                setTimeout(function () {
                    instantJoined = false;
                    instantLocked = false;
                    instantWatchOnly = false;
                    instantMyCards = [];
                    instantSelected.clear();
                    updateInstantCost();
                    updateInstantSelectedDisplay();
                    // If still on play screen, go back to selection
                    if (!document.getElementById('instantPlayBox')?.classList.contains('hidden')) {
                        leaveInstantPlay();
                    }
                    const btn = document.getElementById('instantJoinBtn');
                    if (btn) btn.disabled = false;
                    renderInstantCards();
                }, 1400);
            });
        } else if (!instantSocket.connected) {
            instantSocket.connect();
        } else {
            instantSocket.emit('instant_sync');
        }
    } catch (e) {
        console.error(e);
    }
}

function renderInstantGridHtml(grid, called, winCells, idPrefix) {
    if (!grid || !grid.length) return '<p class="small">—</p>';
    const headers = ['B', 'I', 'N', 'G', 'O'];
    const winSet = new Set((winCells || []).map(function (c) { return Array.isArray(c) ? c.join(',') : String(c); }));
    const calledSet = new Set((called || []).map(Number));
    let html = '<table class="instant-bingo-table" id="' + idPrefix + '"><thead><tr>';
    headers.forEach(function (h) { html += '<th>' + h + '</th>'; });
    html += '</tr></thead><tbody>';
    for (let r = 0; r < 5; r++) {
        html += '<tr>';
        for (let c = 0; c < 5; c++) {
            const v = grid[r][c];
            const isFree = v === 'FREE' || v === 0 || (r === 2 && c === 2);
            const marked = isFree || calledSet.has(Number(v));
            const win = winSet.has(r + ',' + c);
            const cls = win ? 'win-line strike' : (marked ? 'marked' : '');
            html += '<td class="' + cls + '" data-r="' + r + '" data-c="' + c + '">' + (isFree ? '★' : v) + '</td>';
        }
        html += '</tr>';
    }
    return html + '</tbody></table>';
}

async function loadInstantHistory() {
    // History panel removed from Instant selection screen; content lives in History tab when Instant is active.
    return;
}

async function renderInstantHistoryTab() {
    const title = document.querySelector('#tabHistory .page-title h2');
    if (title) title.textContent = '⚡ Instant';
    const list = document.getElementById('historyList');
    if (!list) return;
    const panel = window._instantHistPanel || 'history';
    const period = window._instantLbPeriod || 'day';

    // Leaderboard panel (small, no infinite scroll needed)
    if (panel === 'leaders') {
        list.innerHTML = '<p class="small">Loading…</p>';
        try {
            let html = '<div style="display:flex;gap:6px;margin-bottom:10px;">' +
                '<button type="button" class="btn-secondary" onclick="window._instantHistPanel=\'history\';renderInstantHistoryTab()" style="width:auto;padding:6px 12px;font-size:11px;">📜 My history</button>' +
                '<button type="button" class="btn-secondary active" onclick="window._instantHistPanel=\'leaders\';renderInstantHistoryTab()" style="width:auto;padding:6px 12px;font-size:11px;">🏆 Leaderboard</button>' +
                '</div>';
            html += '<div style="display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap;">' +
                '<button type="button" class="btn-secondary' + (period === 'day' ? ' active' : '') + '" onclick="window._instantLbPeriod=\'day\';renderInstantHistoryTab()" style="width:auto;padding:4px 8px;font-size:10px;">Day</button>' +
                '<button type="button" class="btn-secondary' + (period === 'week' ? ' active' : '') + '" onclick="window._instantLbPeriod=\'week\';renderInstantHistoryTab()" style="width:auto;padding:4px 8px;font-size:10px;">Week</button>' +
                '<button type="button" class="btn-secondary' + (period === 'all' ? ' active' : '') + '" onclick="window._instantLbPeriod=\'all\';renderInstantHistoryTab()" style="width:auto;padding:4px 8px;font-size:10px;">All</button>' +
                '</div>';
            const lbRes = await fetch('/api/instant/leaderboard?period=' + encodeURIComponent(period) + '&_=' + Date.now(), { cache: 'no-store' });
            const lbData = await lbRes.json();
            if (!lbData.success || !lbData.leaders || !lbData.leaders.length) {
                html += '<p class="small">No winners yet.</p>';
            } else {
                html += lbData.leaders.map(function (row, i) {
                    const mult = Number(row.multiplier) || 0;
                    const multLabel = mult ? mult + 'X' : '—';
                    const bet = Number(row.paid || row.stake || 0);
                    const prize = Number(row.prize || 0);
                    const gridHtml = row.grid ? renderInstantGridHtml(row.grid, row.drawnNumbers || [], row.winningCells || [], 'lb' + period + i) : '';
                    return '<div class="instant-lb-row"><div class="instant-lb-meta">' +
                        '<strong>#' + (i + 1) + ' ' + escapeHtmlInstant(row.username) + '</strong><br>' +
                        'Bet ' + bet.toFixed(0) + ' · Won ' + prize.toFixed(0) + ' · <b>' + multLabel + '</b>' +
                        '</div><div class="instant-lb-card">' + gridHtml + '</div></div>';
                }).join('');
            }
            list.innerHTML = html;
        } catch (_) {
            list.innerHTML = '<p class="small">Could not load leaderboard.</p>';
        }
        return;
    }

    // My history — first page
    window._instantHistOffset = 0;
    window._instantHistHasMore = true;
    window._instantHistLoading = false;
    list.innerHTML =
        '<div style="display:flex;gap:6px;margin-bottom:10px;">' +
        '<button type="button" class="btn-secondary active" onclick="window._instantHistPanel=\'history\';renderInstantHistoryTab()" style="width:auto;padding:6px 12px;font-size:11px;">📜 My history</button>' +
        '<button type="button" class="btn-secondary" onclick="window._instantHistPanel=\'leaders\';renderInstantHistoryTab()" style="width:auto;padding:6px 12px;font-size:11px;">🏆 Leaderboard</button>' +
        '</div>' +
        '<div id="instantHistItems"></div>' +
        '<div id="instantHistSentinel" class="small" style="text-align:center;padding:12px;opacity:.7;">Loading…</div>';

    await loadMoreInstantHistory();

    // Infinite scroll on the history list / window
    if (window._instantHistScrollBound) {
        try { list.removeEventListener('scroll', window._instantHistScrollBound); } catch (_) {}
        try { window.removeEventListener('scroll', window._instantHistScrollBound); } catch (_) {}
    }
    window._instantHistScrollBound = function () {
        if (!window._instantHistHasMore || window._instantHistLoading) return;
        const sentinel = document.getElementById('instantHistSentinel');
        if (!sentinel) return;
        const rect = sentinel.getBoundingClientRect();
        if (rect.top < window.innerHeight + 80) {
            loadMoreInstantHistory();
        }
    };
    window.addEventListener('scroll', window._instantHistScrollBound, { passive: true });
}

async function loadMoreInstantHistory() {
    if (window._instantHistLoading || window._instantHistHasMore === false) return;
    window._instantHistLoading = true;
    const items = document.getElementById('instantHistItems');
    const sentinel = document.getElementById('instantHistSentinel');
    if (sentinel) sentinel.textContent = 'Loading…';
    try {
        const offset = window._instantHistOffset || 0;
        const limit = 12;
        const res = await fetch(
            '/api/instant/history?username=' + encodeURIComponent(currentUsername || '') +
            '&limit=' + limit + '&offset=' + offset + '&_=' + Date.now(),
            { cache: 'no-store' }
        );
        const data = await res.json();
        if (!data.success) throw new Error('fail');
        const batch = data.history || [];
        if (!items) return;
        if (offset === 0 && !batch.length) {
            items.innerHTML = '<p class="small">No plays yet.</p>';
            if (sentinel) sentinel.textContent = '';
            window._instantHistHasMore = false;
            return;
        }
        const html = batch.map(function (h) {
            const won = Number(h.prize) > 0;
            const mult = Number(h.multiplier) || 0;
            const bet = Number(h.paid != null ? h.paid : (h.stake || 0));
            const prize = Number(h.prize || 0);
            const gridHtml = h.grid ? renderInstantGridHtml(h.grid, h.drawnNumbers || [], h.winningCells || [], 'hist' + h.id) : '';
            const outcome = won
                ? ('Won ' + prize.toFixed(0) + ' · <b>' + mult + 'X</b> on bet ' + bet.toFixed(0))
                : ('LOSE · Bet ' + bet.toFixed(0));
            return '<div class="instant-lb-row">' +
                '<div class="instant-lb-meta"><strong>#' + h.cardNumber + '</strong><br>' +
                outcome +
                '<br><span style="opacity:.65">' + (h.date ? new Date(h.date).toLocaleString() : '') + '</span></div>' +
                '<div class="instant-lb-card">' + gridHtml + '</div></div>';
        }).join('');
        items.insertAdjacentHTML('beforeend', html);
        window._instantHistOffset = offset + batch.length;
        window._instantHistHasMore = data.hasMore !== false && batch.length >= limit;
        if (sentinel) sentinel.textContent = window._instantHistHasMore ? 'Scroll for more…' : 'End of history';
    } catch (_) {
        if (sentinel) sentinel.textContent = 'Could not load more.';
    } finally {
        window._instantHistLoading = false;
    }
}

window.renderInstantHistoryTab = renderInstantHistoryTab;

async function loadInstantLeaderboard(period) {
    period = period || 'day';
    window._instantLbPeriod = period;
    document.querySelectorAll('.instant-lb-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-period') === period);
    });
    const box = document.getElementById('instantLeaderboard');
    if (!box) return;
    box.innerHTML = '…';
    try {
        const res = await fetch('/api/instant/leaderboard?period=' + encodeURIComponent(period) + '&_=' + Date.now(), { cache: 'no-store' });
        const data = await res.json();
        if (!data.success || !data.leaders || !data.leaders.length) {
            box.innerHTML = '<p class="small">No winners yet.</p>';
            return;
        }
        box.innerHTML = data.leaders.map(function (row, i) {
            const mult = Number(row.multiplier) || 0;
            const multLabel = mult ? mult + 'X' : '—';
            const gridHtml = row.grid ? renderInstantGridHtml(row.grid, row.drawnNumbers || [], row.winningCells || [], 'lb' + period + i) : '';
            return '<div class="instant-lb-row"><div class="instant-lb-meta">' +
                '<strong>#' + (i + 1) + ' ' + escapeHtmlInstant(row.username) + '</strong><br>' +
                'Bet ' + Number(row.paid).toFixed(0) + ' · Won ' + Number(row.prize).toFixed(0) + ' · <b>' + multLabel + '</b>' +
                '</div><div class="instant-lb-card">' + gridHtml + '</div></div>';
        }).join('');
    } catch (_) {
        box.innerHTML = '<p class="small">Leaderboard unavailable.</p>';
    }
}
window.loadInstantLeaderboard = loadInstantLeaderboard;

function escapeHtmlInstant(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

