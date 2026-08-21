let currentUsername = "";
const selectedCards = new Set();
const takenCardsMap = {};
const socket = io();

// -------------------- REAL-TIME SOCKET LISTENERS --------------------
socket.on('init_state', ({ status, timer, takenCards, readyPlayersCount }) => {
    Object.assign(takenCardsMap, takenCards);
    updateTimerUI(timer);
    updateReadyCountUI(readyPlayersCount);

    if (status === 'GAME_ACTIVE') {
        lockSelectionPage("A game is currently in progress. Please wait for the next round!");
    }
});

socket.on('timer_tick', ({ timer }) => {
    updateTimerUI(timer);
});

// Automatic reset when countdown ends without enough ready players
socket.on('lobby_reset', ({ message }) => {
    selectedCards.clear();
    Object.keys(takenCardsMap).forEach(key => delete takenCardsMap[key]);

    resetPlayButton();
    unlockSelectionPage();
    updateGridUI();
    updateSelectedCount();
    updateTimerUI(40);
    updateReadyCountUI(0);

    showNotification(message);
});

socket.on('ready_count_updated', ({ readyCount }) => {
    updateReadyCountUI(readyCount);
});

socket.on('card_taken', ({ cardNumber, username }) => {
    takenCardsMap[cardNumber] = username;
    if (username === currentUsername) selectedCards.add(cardNumber);
    updateGridUI();
    updateSelectedCount();
});

socket.on('card_freed', ({ cardNumber }) => {
    delete takenCardsMap[cardNumber];
    selectedCards.delete(cardNumber);
    updateGridUI();
    updateSelectedCount();
});

socket.on('game_started', ({ gameId, players }) => {
    if (players.includes(currentUsername)) {
        // Ready player: transition to game room
        document.getElementById('selectionBox').classList.add('hidden');
        document.getElementById('gamePlayBox').classList.remove('hidden');
    } else {
        // Non-ready player: lock selection during active play
        lockSelectionPage("Round in progress! Waiting for next 40s countdown...");
    }
});

// Non-blocking win screen transition
socket.on('game_ended', ({ winner }) => {
    // 1. Reset card state
    selectedCards.clear();
    Object.keys(takenCardsMap).forEach(key => delete takenCardsMap[key]);

    // 2. Reset play button back to default state
    resetPlayButton();
    unlockSelectionPage();

    // 3. Automatically return all users to card selection screen
    document.getElementById('gamePlayBox').classList.add('hidden');
    document.getElementById('selectionBox').classList.remove('hidden');

    // 4. Update UI grids & counters
    updateGridUI();
    updateSelectedCount();
    updateReadyCountUI(0);

    // 5. Display non-blocking winner banner
    showNotification(`🎉 BINGO! ${winner} won the game! Select cards for the next round.`);
});

socket.on('error_message', ({ message }) => {
    showNotification(message);
});

// -------------------- UI HELPER FUNCTIONS --------------------
function resetPlayButton() {
    const btn = document.getElementById('playGameBtn');
    if (btn) {
        btn.innerText = "Start Playing 🚀";
        btn.disabled = selectedCards.size === 0;
    }
}

function showNotification(message) {
    const noticeElem = document.getElementById('lockoutNotice');
    if (noticeElem) {
        noticeElem.innerText = message;
        noticeElem.classList.remove('hidden');
        setTimeout(() => {
            if (noticeElem.innerText === message) {
                noticeElem.classList.add('hidden');
            }
        }, 4000);
    }
}

function updateTimerUI(seconds) {
    const timerElem = document.getElementById('lobbyTimer');
    if (timerElem) timerElem.innerText = `${seconds}s`;
}

function updateReadyCountUI(count) {
    const readyElem = document.getElementById('readyCount');
    if (readyElem) readyElem.innerText = count;
}

function lockSelectionPage(message) {
    const grid = document.getElementById('cardGrid');
    if (grid) grid.style.pointerEvents = 'none';
    showNotification(message);
}

function unlockSelectionPage() {
    const grid = document.getElementById('cardGrid');
    if (grid) grid.style.pointerEvents = 'auto';
    const noticeElem = document.getElementById('lockoutNotice');
    if (noticeElem) noticeElem.classList.add('hidden');
}

// Player Ready Trigger
function launchGame() {
    if (selectedCards.size === 0) return;

    socket.emit('player_ready', { username: currentUsername });
    const btn = document.getElementById('playGameBtn');
    btn.disabled = true;
    btn.innerText = "Waiting for game start...";
}

// Trigger BINGO Win Claim
function claimBingo() {
    socket.emit('claim_bingo', { username: currentUsername });
}

window.addEventListener('DOMContentLoaded', async () => {
    const tg = window.Telegram?.WebApp;
    const initData = tg?.initData;

    if (initData) {
        // Hide manual logout button for Telegram native users
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) logoutBtn.classList.add('hidden');

        try {
            const res = await fetch('/api/telegram-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initData })
            });
            const data = await res.json();

            if (data.success && data.status === 'LOGGED_IN') {
                // Auto-login complete: bypass registration screens completely
                showHomeScreen(data.username);
            } else {
                showAuthBox();
            }
        } catch (err) {
            showAuthBox();
        }
    } else {
        // Web browser users (Non-Telegram)
        const savedUser = localStorage.getItem('bingoUser');
        if (savedUser) showHomeScreen(savedUser);
        else showAuthBox();
    }
});

function showAuthBox() {
    document.getElementById('authBox').classList.remove('hidden');
    document.getElementById('headerBar').classList.add('hidden');
    document.getElementById('bottomNav').classList.add('hidden');
    document.getElementById('homeBox').classList.add('hidden');
    document.getElementById('selectionBox').classList.add('hidden');
    document.getElementById('gamePlayBox').classList.add('hidden');
}

function showHomeScreen(username) {
    currentUsername = username;
    localStorage.setItem('bingoUser', username);

    document.getElementById('playerDisplay').innerText = username;
    document.getElementById('headerBar').classList.remove('hidden');
    document.getElementById('bottomNav').classList.remove('hidden');
    document.getElementById('authBox').classList.add('hidden');

    switchTab('tabGames', document.querySelectorAll('.nav-item')[0]);
}

// Explicit Logout (Only used by Non-Telegram Web Users)
function logoutUser() {
    localStorage.removeItem('bingoUser');
    currentUsername = "";
    showAuthBox();
}

function switchTab(tabId, navElement) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));

    document.getElementById(tabId).classList.remove('hidden');
    if (navElement) navElement.classList.add('active');
}

async function goToGameScreen() {
    document.getElementById('homeBox').classList.add('hidden');
    document.getElementById('selectionBox').classList.remove('hidden');

    const res = await fetch('/api/cards/numbers');
    const data = await res.json();
    if (data.success) renderCardNumbers(data.cardNumbers);
}

function renderCardNumbers(cardNumbers) {
    const gridContainer = document.getElementById('cardGrid');
    gridContainer.innerHTML = '';

    cardNumbers.forEach(num => {
        const item = document.createElement('div');
        item.className = 'card-item';
        item.innerText = num;
        item.onclick = () => socket.emit('toggle_card', { cardNumber: num, username: currentUsername });
        gridContainer.appendChild(item);
    });

    updateGridUI();
}

function updateGridUI() {
    document.querySelectorAll('.card-item').forEach(item => {
        const num = parseInt(item.innerText, 10);
        item.className = 'card-item';
        if (takenCardsMap[num]) {
            if (takenCardsMap[num] === currentUsername) item.classList.add('selected');
            else item.classList.add('taken');
        }
    });
}

function updateSelectedCount() {
    const count = selectedCards.size;
    document.getElementById('selectedCount').innerText = count;
    
    // Only update button enabled status if it's not waiting for a match
    const btn = document.getElementById('playGameBtn');
    if (btn && btn.innerText !== "Waiting for game start...") {
        btn.disabled = count === 0;
    }
}