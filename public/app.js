let currentUsername = "";
let currentStake = null;
let pendingStake = null;
let currentRoom = null;
let cachedCards = null;
const selectedCards = new Set();
const takenCardsMap = {};
const socket = io();

socket.on('connect', () => setConnection(true));
socket.on('disconnect', () => setConnection(false));

socket.on('rooms_state', rooms => {
    window.latestRooms = rooms || [];
    renderRooms();
});

socket.on('room_state', state => {
    if (currentStake === Number(state.stake)) {
        currentRoom = state;
        syncRoomUI(state);
    }
    renderRooms();
});

socket.on('room_tick', state => {
    if (currentStake === Number(state.stake)) {
        currentRoom = { ...currentRoom, ...state };
        syncRoomUI(currentRoom);
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

socket.on('game_started', ({ stake, gameId, prizePool, drawn }) => {
    if (Number(stake) !== currentStake) return;
    currentRoom = { ...currentRoom, status: 'PLAYING', gameId, prizePool, drawn: drawn || [] };
    hide('selectionBox');
    show('gamePlayBox');
    document.getElementById('activeStake').innerText = `${stake} Birr`;
    document.getElementById('activePrize').innerText = `${Number(prizePool).toFixed(2)} Birr`;
    renderMyGameCards();
    updateCalledNumbers();
});

socket.on('game_ended', async ({ stake, winner, prize }) => {
    if (Number(stake) !== currentStake) return;
    alert(`🏆 ${winner} won ${Number(prize).toFixed(2)} Birr!`);
    await loadUserData(currentUsername);
    returnToRooms();
});

socket.on('room_reset', ({ stake, message }) => {
    if (Number(stake) !== currentStake) return;
    if (message) alert(message);
    returnToRooms();
});

socket.on('error_message', ({ message }) => showNotification(message));

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
                <div class="room-meta">👥 ${room.players} players</div>
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
    if (currentStake) socket.emit('unsubscribe_room', { stake: currentStake });
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

    if (!cachedCards) {
        const res = await fetch('/api/cards/numbers');
        const data = await res.json();
        if (!data.success) return showNotification('Failed to load cards.');
        cachedCards = data.cardNumbers;
    }
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
    socket.emit('toggle_card', { stake: currentStake, cardNumber, username: currentUsername }, response => {
        if (!response?.success) showNotification(response?.message || 'Could not update card.');
    });
}

function updateGridUI() {
    document.querySelectorAll('.card-item').forEach(el => {
        const cardNumber = Number(el.dataset.card);
        el.classList.toggle('selected', selectedCards.has(cardNumber));
        el.classList.remove('taken');
    });
}

function updateSelectedCount() {
    const count = selectedCards.size;
    document.getElementById('selectedCount').innerText = count;
    const btn = document.getElementById('playGameBtn');
    if (btn && !btn.dataset.ready) btn.disabled = count === 0;
}

function syncRoomUI(room) {
    if (!room) return;
    document.getElementById('lobbyTimer').innerText = `${Math.max(0, room.timer)}s`;
    document.getElementById('readyCount').innerText = room.readyPlayers || 0;
    document.getElementById('lobbyStatus').innerText = formatStatus(room);

    renderMyGame();
}

function launchGame() {
    if (!currentStake || selectedCards.size === 0) return;
    socket.emit('player_ready', { stake: currentStake, username: currentUsername }, response => {
        if (!response?.success) return showNotification(response?.message || 'Could not mark ready.');
        const btn = document.getElementById('playGameBtn');
        btn.disabled = true; btn.dataset.ready = '1'; btn.innerText = 'READY — Waiting for start...';
    });
}

function claimBingo(cardNumber) {
    if (!currentStake || !cardNumber) return;
    socket.emit('claim_bingo', { stake: currentStake, username: currentUsername, cardNumber }, response => {
        if (!response?.success) showNotification(response?.message || 'Bingo is not valid yet.');
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
    switchTab('tabGames', document.querySelector('.nav-item'));
    showHome();
    await loadUserData(username);
    await fetchNotifications(username);
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
        if (data.success && data.user) document.getElementById('balanceDisplay').innerText = Number(data.user.balance || 0).toFixed(2);
    } catch (err) { console.error(err); }
}

function switchTab(tabId, navElement) {
    document.querySelectorAll('.tab-content').forEach(t => hide(t.id));
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    show(tabId);
    navElement?.classList.add('active');
}

function logoutUser() {
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
    try {
        const res = await fetch(`/api/notifications?username=${encodeURIComponent(username)}`);
        const data = await res.json();
        if (!data.success) return;
        cachedNotifications = data.notifications || [];
        const badge = document.getElementById('notifBadge');
        const seen = localStorage.getItem(`notifSeen_${username}`) === 'true';
        const unread = seen ? 0 : (data.unreadCount || 0);
        badge.innerText = unread;
        badge.classList.toggle('hidden', unread === 0);
        renderNotificationsList(cachedNotifications);
    } catch (err) { console.error(err); }
}

function renderNotificationsList(posts) {
    document.getElementById('notifListContainer').innerHTML = posts.length ? posts.map(post => `
      <div style="background:#252525;border:1px solid #333;border-radius:10px;padding:12px;margin-bottom:10px;">
        ${post.image_url ? `<img src="${post.image_url}" style="width:100%;border-radius:8px;margin-bottom:10px;" onerror="this.remove()">` : ''}
        <div style="line-height:1.5">${String(post.message || '').replace(/\n/g,'<br>')}</div>
        <div class="small" style="margin-top:8px">${new Date(post.created_at).toLocaleString()}</div>
      </div>`).join('') : '<p class="small">No announcements yet.</p>';
}

function toggleNotificationModal() {
    document.getElementById('notifModal').classList.toggle('hidden');
    if (!document.getElementById('notifModal').classList.contains('hidden') && currentUsername) {
        localStorage.setItem(`notifSeen_${currentUsername}`, 'true');
        hide('notifBadge');
    }
}
