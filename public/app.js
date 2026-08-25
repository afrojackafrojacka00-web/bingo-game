

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
const socket = io();

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
    localStorage.setItem('bingoActiveGame', JSON.stringify({username: currentUsername, stake:Number(stake), gameId}));
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
            localStorage.setItem('bingoActiveGame', JSON.stringify({ username: currentUsername, stake:Number(stake), gameId:state.gameId }));
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

async function ensureCardsCached() {
    if (cachedCards) return;
    const res = await fetch('/api/cards/numbers');
    const data = await res.json();
    if (data.success) cachedCards = data.cardNumbers;
}


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
                <div class="room-meta">🃏 ${room.totalCards || 0} cards playing</div>
            </div>
            <div class="room-status ${statusClass}">
                🏆 ${Number(room.prizePool).toFixed(2)} Birr<br>
                ${formatStatus(room)}
            </div>
            <button class="room-join" ${disabled ? 'disabled' : ''} onclick="openJoinModal(${Number(room.stake)})">${disabled ? 'PLAYING' : 'JOIN'}</button>
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

function openJoinModal(stake) {
    if (currentStake && currentStake !== Number(stake)) {
        return alert(`You are already in the ${currentStake} Birr room.`);
    }
    const room = (window.latestRooms || []).find(r => Number(r.stake) === Number(stake));
    if (!room || room.status === 'PLAYING') return;
    pendingStake = Number(stake);
    document.getElementById('confirmStake').innerText = `${pendingStake} Birr`;
    document.getElementById('confirmPlayers').innerText = room.players;
    document.getElementById('confirmPool').innerText = `${Number((room.players + 1) * pendingStake).toFixed(2)} Birr`;
    document.getElementById('confirmStatus').innerText = formatStatus(room);
    show('joinModal');
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
    show('roomsBox');
    socket.emit('rooms_state_request'); // harmless for older/newer server versions
    renderRooms();
}

function showHome() {
    hide('roomsBox');
    hide('selectionBox');
    hide('gamePlayBox');
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
    if (!confirm(`Leave the ${currentStake} Birr room? Your stake will be refunded if the game has not started.`)) return;

    socket.emit('leave_room', { stake: currentStake, username: currentUsername }, async response => {
        if (!response?.success) return alert(response?.message || 'Unable to leave room.');
        await loadUserData(currentUsername);
        returnToRooms();
    });
}

async function openSelection() {
    hide('homeBox');
    hide('roomsBox');
    hide('gamePlayBox');
    show('selectionBox');
    document.getElementById('selectionTitle').innerText = `🎟️ ${currentStake} Birr — Select Cards`;

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
    grid.innerHTML = cardNumbers.map(number =>
        `<div class="card-item" data-card="${number}" onclick="toggleCard(${number})">${number}</div>`
    ).join('');
    updateGridUI();
    updateSelectedCount();
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

            const btn = document.getElementById('playGameBtn');
            if (!btn) return;

            btn.disabled = true;
            btn.dataset.ready = '1';
            btn.innerText = 'READY — Waiting for start...';
        }
    );
}

function claimBingo(cardNumber) {
    if (!currentStake || !cardNumber) return;
    const stake = currentStake; // captured now, compared below in case a broadcast beats the ack

    document.querySelectorAll('#myGameCards .game-card-choice').forEach(btn => btn.disabled = true);

    socket.emit('claim_bingo', { stake, username: currentUsername, cardNumber }, async response => {
        if (!response?.success) {
            showNotification(response?.message || 'Bingo is not valid yet.');
            document.querySelectorAll('#myGameCards .game-card-choice').forEach(btn => btn.disabled = false);
            return;
        }

        // Success is confirmed directly by the server, independent of whether
        // this socket was still in the room to receive the game_ended/room_reset
        // broadcast — this is what fixes the "I clicked Claim and nothing
        // happened" case. If the broadcast already handled this (currentStake
        // was cleared by it before this ack arrived), don't do it twice.
        if (currentStake !== stake) return;

        alert(`🏆 You won ${Number(response.prize || 0).toFixed(2)} Birr!`);
        await loadUserData(currentUsername);
        returnToRooms();
    });
}

function renderMyGameCards() {
    const wrap = document.getElementById('myGameCards');
    if (!wrap) return;
    wrap.innerHTML = Array.from(selectedCards).sort((a,b)=>a-b).map(card =>
        `<button class="game-card-choice" onclick="claimBingo(${card})">CARD ${card}<small>Claim Bingo</small></button>`).join('');
}
function updateCalledNumbers() {
    const el = document.getElementById('calledNumbers');
    if (!el) return;
    const drawn = currentRoom?.drawn || [];
    el.innerHTML = drawn.length ? drawn.map(n=>`<span class="ball">${n}</span>`).join('') : '<span class="small">Waiting for first number…</span>';
}

// ---------------- AUTH / USER ----------------
window.addEventListener('DOMContentLoaded', async () => {
    const tg = window.Telegram?.WebApp;
    const initData = tg?.initData;

    if (initData) {
        tg.expand();
        document.getElementById('logoutBtn')?.classList.add('hidden');
        try {
            const res = await fetch('/api/telegram-auth', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({ initData })
            });
            const data = await res.json();
            if (data.success && data.status === 'LOGGED_IN') {
                currentUsername = data.username;
                localStorage.setItem('bingoUser', currentUsername);
                if (!data.phoneVerified) show('phoneModal');
                else await showHomeScreen(currentUsername);
            } else showAuthBox();
        } catch { showAuthBox(); }
    } else {
        const saved = localStorage.getItem('bingoUser');
        if (saved) await showHomeScreen(saved);
        else showAuthBox();
    }
});

function showAuthBox() {
    show('authBox');
    hide('headerBar'); hide('bottomNav');
    document.querySelectorAll('.tab-content').forEach(t => hide(t.id));
}

async function showHomeScreen(username) {
    currentUsername = username;
    localStorage.setItem('bingoUser', username);
    document.getElementById('playerDisplay').innerText = username;
    hide('authBox'); show('headerBar'); show('bottomNav');
    applyLanguage(localStorage.getItem('bingoLang') || 'en', false);
    switchTab('tabGames', document.querySelector('.nav-item'));
    showHome();

    await loadUserData(username);
    await fetchNotifications(username);

    const returnStake = Number(new URLSearchParams(location.search).get('returnStake') || 0);
    if (returnStake) setTimeout(()=>{ pendingStake=returnStake; confirmJoin(); }, 500);

    if (notificationRefreshTimer) clearInterval(notificationRefreshTimer);
    notificationRefreshTimer = setInterval(() => {
        if (currentUsername) fetchNotifications(currentUsername);
    }, 10000);
}

function switchToRegister() { hide('loginForm'); show('registerForm'); }
function switchToLogin() { hide('registerForm'); show('loginForm'); }

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
        const res = await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,phoneNumber})});
        const data = await res.json();
        if (data.success) await showHomeScreen(data.username);
        else alert(data.message || 'Registration failed.');
    } catch { alert('Registration failed.'); }
}

async function loadUserData(username) {
    try {
        const res = await fetch(`/api/user-details?username=${encodeURIComponent(username)}`);
        const data = await res.json();
        if (data.success && data.user) {
            const balance = Number(data.user.balance || 0).toFixed(2);
            document.getElementById('balanceDisplay').innerText = balance;

            const walletBalance = document.getElementById('walletBalanceDisplay');
            if (walletBalance) walletBalance.innerText = `${balance} Birr`;

            const profileUsername = document.getElementById('profileUsername');
            if (profileUsername) profileUsername.innerText = data.user.username;

            const profilePhone = document.getElementById('profilePhone');
            if (profilePhone) profilePhone.innerText = data.user.phone_number || 'Not set';

            const lang = data.user.preferred_language || 'en';
            const langSelect = document.getElementById('languageSelect');
            if (langSelect) langSelect.value = lang;
            applyLanguage(lang, false);
        }
    } catch (err) { console.error(err); }
}

// ---------------- HISTORY ----------------
async function fetchHistory(username) {
    if (!username) return;
    const container = document.getElementById('historyList');
    if (!container) return;

    container.innerHTML = '<p class="small">Loading your game history…</p>';

    try {
        const res = await fetch(`/api/history?username=${encodeURIComponent(username)}`, { cache: 'no-store' });
        const data = await res.json();
        if (!data.success) return container.innerHTML = '<p class="small">Could not load history.</p>';
        renderHistory(data.history || []);
    } catch (err) {
        console.error('History fetch error:', err);
        container.innerHTML = '<p class="small">Could not load history.</p>';
    }
}

function renderHistory(games) {
    const container = document.getElementById('historyList');
    if (!container) return;

    if (!games.length) {
        container.innerHTML = '<p class="small">You haven\'t completed a game yet. Your finished games will show up here.</p>';
        return;
    }

    container.innerHTML = games.map(game => {
        const won = game.won;
        const outcomeClass = won ? 'won' : 'lost';
        const outcomeLabel = won ? '🏆 You Won' : (game.winner ? '❌ You Lost' : '➖ No Winner');
        const dateStr = new Date(game.date).toLocaleString();
        return `<div class="history-card ${outcomeClass}">
            <div class="history-top">
                <span class="history-outcome">${outcomeLabel}</span>
                <span class="history-date">${dateStr}</span>
            </div>
            <div class="info-grid" style="margin:10px 0 0;">
                <div class="info-box"><span>PLAYERS</span><strong>${game.players}</strong></div>
                <div class="info-box"><span>WINNER</span><strong>${game.winner || 'None'}</strong></div>
                <div class="info-box"><span>PRIZE</span><strong>${game.prizePool.toFixed(2)} Birr</strong></div>
                <div class="info-box"><span>STAKE</span><strong>${game.stake.toFixed(0)} Birr</strong></div>
            </div>
        </div>`;
    }).join('');
}

// ---------------- WALLET ----------------
async function fetchWallet(username) {
    if (!username) return;
    const list = document.getElementById('walletTransactions');

    try {
        const res = await fetch(`/api/wallet?username=${encodeURIComponent(username)}`, { cache: 'no-store' });
        const data = await res.json();
        if (!data.success) return;

        const walletBalance = document.getElementById('walletBalanceDisplay');
        if (walletBalance) walletBalance.innerText = `${Number(data.balance).toFixed(2)} Birr`;

        if (list) renderWalletTransactions(data.transactions || []);
    } catch (err) {
        console.error('Wallet fetch error:', err);
    }
}

function renderWalletTransactions(transactions) {
    const list = document.getElementById('walletTransactions');
    if (!list) return;

    if (!transactions.length) {
        list.innerHTML = '<p class="small">No transactions yet.</p>';
        return;
    }

    list.innerHTML = transactions.map(tx => {
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
        GAME_REFUND_START_ERROR: 'Refund (Start Error)'
    };
    return labels[type] || type;
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
        accountTitle: 'Account Settings ⚙️', accountBody: 'Set a password for standard web login.', accountSaveBtn: 'Save Web Password 🔒',
        profileTitle: '👤 Profile', profileUsernameLbl: 'USERNAME', profilePhoneLbl: 'PHONE', profileLangLbl: 'Language',
        announcementsTitle: '📢 Announcements'
    },
    am: {
        navGames: 'ጨዋታዎች', navHistory: 'ታሪክ', navWallet: 'ዋሌት', navAccount: 'መለያ',
        readyTitle: 'ለመጫወት ተዘጋጅተዋል? 🎲', readyBody: 'ውርርድ ይምረጡ፣ ክፍል ይቀላቀሉ፣ ካርድዎን ይምረጡ እና ይጫወቱ።', playBtn: 'ቢንጎ ይጫወቱ 🚀',
        walletTitle: '💰 የኔ ዋሌት', walletSub: 'የአሁኑ ቀሪ ሂሳብዎ', walletTxTitle: 'የቅርብ ጊዜ ግብይቶች',
        historyTitle: '🏆 የጨዋታ ታሪክ',
        accountTitle: 'የመለያ ቅንብሮች ⚙️', accountBody: 'መደበኛ የድር መግቢያ የይለፍ ቃል ያዘጋጁ።', accountSaveBtn: 'የድር የይለፍ ቃል ያስቀምጡ 🔒',
        profileTitle: '👤 መገለጫ', profileUsernameLbl: 'የተጠቃሚ ስም', profilePhoneLbl: 'ስልክ', profileLangLbl: 'ቋንቋ',
        announcementsTitle: '📢 ማስታወቂያዎች'
    }
};

function applyLanguage(language, persistLocally = true) {
    const lang = translations[language] ? language : 'en';
    const t = translations[lang];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (t[key]) el.innerText = t[key];
    });

    if (persistLocally) localStorage.setItem('bingoLang', lang);
}

function switchTab(tabId, navElement) {
    document.querySelectorAll('.tab-content').forEach(t => hide(t.id));
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    show(tabId);
    navElement?.classList.add('active');

    if (tabId === 'tabHistory') fetchHistory(currentUsername);
    if (tabId === 'tabWallet') fetchWallet(currentUsername);
}

function logoutUser() {
    stopLobbyTimer();
    if (notificationRefreshTimer) {
        clearInterval(notificationRefreshTimer);
        notificationRefreshTimer = null;
    }
    if (currentStake && currentRoom?.status !== 'PLAYING') {
        socket.emit('leave_room', { stake: currentStake, username: currentUsername });
    }
    localStorage.removeItem('bingoUser');
    currentUsername = '';
    currentStake = null;
    currentRoom = null;
    showAuthBox();
}

async function setWebPassword() {
    const newPassword = document.getElementById('webPasswordInput').value.trim();
    if (!newPassword) return alert('Please enter a password.');
    const res = await fetch('/api/set-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:currentUsername,newPassword})});
    const data = await res.json();
    alert(data.message || (data.success ? 'Saved.' : 'Failed.'));
    if (data.success) document.getElementById('webPasswordInput').value = '';
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
            <div style="background:#252525;border:1px solid #333;border-radius:10px;padding:12px;margin-bottom:10px;">
                ${post.image_url
                    ? `<img src="${post.image_url}" style="width:100%;border-radius:8px;margin-bottom:10px;" onerror="this.remove()">`
                    : ''}
                <div style="line-height:1.5">${String(post.message || '').replace(/\n/g, '<br>')}</div>
                <div class="small" style="margin-top:8px">${new Date(post.created_at).toLocaleString()}</div>
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








