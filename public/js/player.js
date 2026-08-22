const socket = io();
let currentUsername = localStorage.getItem('bingo_username') || '';
let mySelectedCards = new Set();
let cardGridsData = {};
let calledNumbersSet = new Set();

// Check user details on load
async function fetchUserDetails() {
    if (!currentUsername) return;
    try {
        const res = await fetch(`/api/user-details?username=${encodeURIComponent(currentUsername)}`);
        const data = await res.json();
        if (data.success) {
            document.getElementById('displayUsername').innerText = data.user.username;
            document.getElementById('userBalance').innerText = parseFloat(data.user.balance).toFixed(2);
            socket.emit('join_user_channel', { username: data.user.username });
        }
    } catch (e) {}
}

// Telegram WebApp Integration
if (window.Telegram?.WebApp?.initData) {
    window.Telegram.WebApp.ready();
    fetch('/api/telegram-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: window.Telegram.WebApp.initData })
    }).then(r => r.json()).then(data => {
        if (data.success && data.username) {
            currentUsername = data.username;
            localStorage.setItem('bingo_username', currentUsername);
            fetchUserDetails();
        }
    });
} else {
    if (!currentUsername) {
        currentUsername = 'Player_' + Math.floor(Math.random() * 8999 + 1000);
        localStorage.setItem('bingo_username', currentUsername);
    }
    fetchUserDetails();
}

// Load Card Selection Grid
async function loadCardNumbers() {
    const res = await fetch('/api/cards/numbers');
    const data = await res.json();
    if (data.success) {
        const container = document.getElementById('cardNumbersGrid');
        container.innerHTML = '';
        data.cardNumbers.forEach(num => {
            const btn = document.createElement('button');
            btn.className = 'card-select-btn';
            btn.innerText = `Card ${num}`;
            btn.dataset.cardNumber = num;
            btn.onclick = () => {
                socket.emit('toggle_card', { cardNumber: num, username: currentUsername });
            };
            container.appendChild(btn);
        });
    }
}
loadCardNumbers();

// Socket Listeners
socket.on('init_state', (data) => {
    document.getElementById('timer').innerText = data.timer;
    document.getElementById('readyCount').innerText = data.readyPlayersCount;
    
    // Update taken cards in UI
    Object.entries(data.takenCards).forEach(([cardNum, owner]) => {
        const btn = document.querySelector(`[data-card-number="${cardNum}"]`);
        if (btn) {
            btn.classList.add(owner === currentUsername ? 'selected-by-me' : 'taken');
            if (owner === currentUsername) mySelectedCards.add(parseInt(cardNum, 10));
        }
    });
});

socket.on('timer_tick', (data) => {
    document.getElementById('timer').innerText = data.timer;
});

socket.on('ready_count_updated', (data) => {
    document.getElementById('readyCount').innerText = data.readyCount;
});

socket.on('card_taken', ({ cardNumber, username }) => {
    const btn = document.querySelector(`[data-card-number="${cardNumber}"]`);
    if (btn) {
        btn.classList.add(username === currentUsername ? 'selected-by-me' : 'taken');
        if (username === currentUsername) mySelectedCards.add(parseInt(cardNumber, 10));
    }
});

socket.on('card_freed', ({ cardNumber }) => {
    const btn = document.querySelector(`[data-card-number="${cardNumber}"]`);
    if (btn) {
        btn.classList.remove('selected-by-me', 'taken');
        mySelectedCards.delete(parseInt(cardNumber, 10));
    }
});

socket.on('game_started', async () => {
    document.getElementById('gameLobby').classList.add('hidden');
    document.getElementById('gamePlayArea').classList.remove('hidden');

    if (mySelectedCards.size > 0) {
        const numbersArr = Array.from(mySelectedCards).join(',');
        const res = await fetch(`/api/cards/grids?cardNumbers=${numbersArr}`);
        const data = await res.json();
        if (data.success) {
            cardGridsData = data.cards;
            renderActiveCards();
        }
    }
});

function renderActiveCards() {
    const container = document.getElementById('activeCardsContainer');
    container.innerHTML = '';

    Object.entries(cardGridsData).forEach(([cardNum, grid]) => {
        const cardWrapper = document.createElement('div');
        cardWrapper.className = 'bingo-card-board';
        cardWrapper.innerHTML = `<h3>Card #${cardNum}</h3>`;

        const table = document.createElement('table');
        grid.forEach(row => {
            const tr = document.createElement('tr');
            row.forEach(cellVal => {
                const td = document.createElement('td');
                td.innerText = cellVal;
                td.dataset.value = cellVal;
                if (cellVal === "FREE") td.classList.add('marked');
                tr.appendChild(td);
            });
            table.appendChild(tr);
        });

        cardWrapper.appendChild(table);
        container.appendChild(cardWrapper);
    });
}

socket.on('number_called', ({ number, history }) => {
    calledNumbersSet.add(number);
    document.getElementById('currentNumber').innerText = number;
    document.getElementById('numberHistory').innerText = history.join(', ');

    // Auto-mark drawn numbers on user's active cards
    document.querySelectorAll('#activeCardsContainer td').forEach(td => {
        if (parseInt(td.dataset.value, 10) === number) {
            td.classList.add('marked');
        }
    });
});

socket.on('balance_updated', (data) => {
    document.getElementById('userBalance').innerText = data.newBalance.toFixed(2);
});

socket.on('game_ended', ({ winner, cardNumber }) => {
    alert(`🎉 Game Over! Winner: ${winner} on Card #${cardNumber}`);
    location.reload();
});

socket.on('lobby_reset', (data) => {
    alert(data.message);
    mySelectedCards.clear();
    document.querySelectorAll('.card-select-btn').forEach(b => b.classList.remove('selected-by-me', 'taken'));
});

socket.on('error_message', (data) => alert(data.message));

// Action Controls
document.getElementById('readyBtn').onclick = () => {
    socket.emit('player_ready', { username: currentUsername });
};

document.getElementById('claimBingoBtn').onclick = () => {
    if (mySelectedCards.size === 0) return alert("No active card!");
    const firstCard = Array.from(mySelectedCards)[0];
    socket.emit('claim_bingo', { username: currentUsername, cardNumber: firstCard });
};

socket.on('admin_announcement_popup', (data) => {
    const modal = document.getElementById('announcementModal');
    document.getElementById('popupMessage').innerText = data.message;
    const img = document.getElementById('popupImage');
    if (data.imageUrl) {
        img.src = data.imageUrl;
        img.classList.remove('hidden');
    } else {
        img.classList.add('hidden');
    }
    modal.classList.remove('hidden');
});

document.getElementById('closeModal').onclick = () => {
    document.getElementById('announcementModal').classList.add('hidden');
};