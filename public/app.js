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

socket.on('timer_reset', ({ message }) => {
    alert(message);
    updateTimerUI(40);
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
        // Active participant: transition to game room
        document.getElementById('selectionBox').classList.add('hidden');
        document.getElementById('gamePlayBox').classList.remove('hidden');
    } else {
        // Non-participant: lock card selection page
        lockSelectionPage("Round in progress! Waiting for next 40s countdown...");
    }
});

socket.on('game_ended', ({ winner }) => {
    alert(`🎉 BINGO! ${winner} won the game! Returning to selection...`);

    // Reset client state
    selectedCards.clear();
    Object.keys(takenCardsMap).forEach(key => delete takenCardsMap[key]);

    // Return all players to card selection view
    unlockSelectionPage();
    document.getElementById('gamePlayBox').classList.add('hidden');
    document.getElementById('selectionBox').classList.remove('hidden');

    updateGridUI();
    updateSelectedCount();
});

socket.on('error_message', ({ message }) => {
    alert(message);
});

// -------------------- UI HELPER FUNCTIONS --------------------
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
    const msgElem = document.getElementById('lockoutNotice');
    if (msgElem) {
        msgElem.innerText = message;
        msgElem.classList.remove('hidden');
    }
}

function unlockSelectionPage() {
    const grid = document.getElementById('cardGrid');
    if (grid) grid.style.pointerEvents = 'auto';
    const msgElem = document.getElementById('lockoutNotice');
    if (msgElem) msgElem.classList.add('hidden');
}

// Player Ready Trigger
function launchGame() {
    socket.emit('player_ready', { username: currentUsername });
    document.getElementById('playGameBtn').disabled = true;
    document.getElementById('playGameBtn').innerText = "Waiting for game start...";
}

// Trigger BINGO Win Claim
function claimBingo() {
    socket.emit('claim_bingo', { username: currentUsername });
}

// -------------------- APP INITIALIZATION & AUTH --------------------
window.addEventListener('DOMContentLoaded', async () => {
    const savedUser = localStorage.getItem('bingoUser');
    if (savedUser) showHomeScreen(savedUser);
});

function showHomeScreen(username) {
    currentUsername = username;
    localStorage.setItem('bingoUser', username);

    document.getElementById('playerDisplay').innerText = username;
    document.getElementById('headerBar').classList.remove('hidden');
    document.getElementById('bottomNav').classList.remove('hidden');
    document.getElementById('authBox').classList.add('hidden');

    switchTab('tabGames', document.querySelectorAll('.nav-item')[0]);
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
    document.getElementById('playGameBtn').disabled = count === 0;
}