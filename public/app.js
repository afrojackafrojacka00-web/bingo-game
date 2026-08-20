let isLogin = true;
let isLinkingFlow = false;
let tgInitData = null;
let currentUsername = "";

const selectedCards = new Set();
const takenCardsMap = {};
const socket = io();

// Real-Time Socket Listeners
socket.on('init_state', ({ takenCards }) => {
    Object.assign(takenCardsMap, takenCards);
    Object.keys(takenCards).forEach(num => {
        const cardNum = parseInt(num, 10);
        if (takenCards[cardNum] === currentUsername) selectedCards.add(cardNum);
    });
    updateGridUI();
    updateSelectedCount();
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

window.addEventListener('DOMContentLoaded', async () => {
    const tg = window.Telegram?.WebApp;

    if (tg && tg.initData) {
        tg.ready();
        tg.expand();
        tgInitData = tg.initData;
        document.getElementById('logoutBtn').classList.add('hidden');

        try {
            const res = await fetch('/api/telegram-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initData: tgInitData })
            });
            const data = await res.json();

            if (data.status === 'LOGGED_IN') {
                showHomeScreen(data.username);
            } else if (data.status === 'NEEDS_CHOICE') {
                document.getElementById('authBox').classList.add('hidden');
                document.getElementById('choiceBox').classList.remove('hidden');
            }
        } catch (err) {
            console.error("Telegram Auth Failed:", err);
        }
    }

    const savedUser = localStorage.getItem('bingoUser');
    if (savedUser) showHomeScreen(savedUser);
});

// Mandatory Telegram Contact Sharing
function requestTelegramPhone() {
    const tg = window.Telegram?.WebApp;
    if (tg && tg.requestContact) {
        tg.requestContact((sent, response) => {
            if (sent && response?.responseUnpacked?.phone_number) {
                const phone = response.responseUnpacked.phone_number;
                savePhoneNumber(phone);
            } else {
                alert("Phone number sharing is required to play on Telegram.");
            }
        });
    } else {
        const phone = prompt("Please enter your phone number:");
        if (phone) savePhoneNumber(phone);
    }
}

async function savePhoneNumber(phoneNumber) {
    const res = await fetch('/api/user/phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUsername, phoneNumber })
    });
    const data = await res.json();
    if (data.success) {
        document.getElementById('phoneModal').classList.add('hidden');
        document.getElementById('tabGames').classList.remove('hidden');
    }
}

function showHomeScreen(username) {
    currentUsername = username;
    localStorage.setItem('bingoUser', username);

    document.getElementById('playerDisplay').innerText = username;
    document.getElementById('profileUserDisplay').innerText = username;
    document.getElementById('headerBar').classList.remove('hidden');
    document.getElementById('bottomNav').classList.remove('hidden');

    document.getElementById('authBox').classList.add('hidden');
    document.getElementById('choiceBox').classList.add('hidden');

    // Default tab: Games
    switchTab('tabGames', document.querySelectorAll('.nav-item')[0]);
}

// Navigation Bar Switching Logic
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
    const items = document.querySelectorAll('.card-item');
    items.forEach(item => {
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

function launchGame() {
    document.getElementById('selectionBox').classList.add('hidden');
    document.getElementById('gamePlayBox').classList.remove('hidden');
}

function backToSelection() {
    document.getElementById('gamePlayBox').classList.add('hidden');
    document.getElementById('selectionBox').classList.remove('hidden');
}

function logout() {
    localStorage.removeItem('bingoUser');
    location.reload();
}