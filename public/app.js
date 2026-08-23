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
        document.getElementById('selectionBox').classList.add('hidden');
        document.getElementById('gamePlayBox').classList.remove('hidden');
    } else {
        lockSelectionPage("Round in progress! Waiting for next 40s countdown...");
    }
});

socket.on('game_ended', ({ winner }) => {
    selectedCards.clear();
    Object.keys(takenCardsMap).forEach(key => delete takenCardsMap[key]);

    resetPlayButton();
    unlockSelectionPage();

    document.getElementById('gamePlayBox').classList.add('hidden');
    document.getElementById('selectionBox').classList.remove('hidden');

    updateGridUI();
    updateSelectedCount();
    updateReadyCountUI(0);

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

function launchGame() {
    if (selectedCards.size === 0) return;

    socket.emit('player_ready', { username: currentUsername });
    const btn = document.getElementById('playGameBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Waiting for game start...";
    }
}

function claimBingo() {
    socket.emit('claim_bingo', { username: currentUsername });
}

// -------------------- APP INITIALIZATION & AUTH --------------------
// Check Phone Verification Status during Telegram Auto-Login
window.addEventListener('DOMContentLoaded', async () => {
    const tg = window.Telegram?.WebApp;
    const initData = tg?.initData;

    if (initData) {
        tg.expand();
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
                currentUsername = data.username;
                localStorage.setItem('bingoUser', data.username);

                // Show modal if phone is not verified via Telegram contact request
                if (!data.phoneVerified) {
                    document.getElementById('phoneModal').classList.remove('hidden');
                } else {
                    showHomeScreen(data.username);
                }
            } else {
                showAuthBox();
            }
        } catch (err) {
            showAuthBox();
        }
    } else {
        // Web Browser User Flow (Phone is optional)
        const savedUser = localStorage.getItem('bingoUser');
        if (savedUser) showHomeScreen(savedUser);
        else showAuthBox();
    }
});

// Prompt Native Telegram Share Contact
function shareTelegramContact() {
    const tg = window.Telegram?.WebApp;
    if (!tg) {
        return alert("This feature is only available inside Telegram.");
    }

    if (tg.requestContact) {
        tg.requestContact(async (sent, event) => {
            if (sent) {
                const phoneNumber = event?.responseUnsafe?.contact?.phone_number || event?.response?.contact?.phone_number;
                if (phoneNumber) {
                    await saveVerifiedTelegramPhone(phoneNumber);
                } else {
                    alert("Could not retrieve phone number. Please try again.");
                }
            } else {
                alert("You must share your Telegram phone number to continue.");
            }
        });
    } else {
        alert("Please update your Telegram app to support contact sharing.");
    }
}

// Save Phone Number to Server
async function saveVerifiedTelegramPhone(phoneNumber) {
    const tg = window.Telegram?.WebApp;
    const initData = tg?.initData;

    try {
        const res = await fetch('/api/save-telegram-phone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData, phoneNumber })
        });
        const data = await res.json();

        if (data.success) {
            document.getElementById('phoneModal').classList.add('hidden');
            showHomeScreen(currentUsername);
        } else {
            alert(data.message || "Failed to save phone number.");
        }
    } catch (err) {
        alert("Network error while saving phone number.");
    }
}


function switchToRegister() {
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('registerForm').classList.remove('hidden');
}

function switchToLogin() {
    document.getElementById('registerForm').classList.add('hidden');
    document.getElementById('loginForm').classList.remove('hidden');
}

function showAuthBox() {
    document.getElementById('authBox').classList.remove('hidden');
    document.getElementById('headerBar').classList.add('hidden');
    document.getElementById('bottomNav').classList.add('hidden');
    document.getElementById('homeBox').classList.add('hidden');
    document.getElementById('selectionBox').classList.add('hidden');
    document.getElementById('gamePlayBox').classList.add('hidden');

    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));

    switchToLogin();
}

async function loginUser() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value.trim();

    if (!username || !password) return alert("Please fill in all fields.");

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (data.success) {
            showHomeScreen(data.username);
        } else {
            alert(data.message || "Invalid credentials.");
        }
    } catch (err) {
        alert("Login failed. Check your network connection.");
    }
}

async function registerUser() {
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    const phoneNumber = document.getElementById('regPhone').value.trim();

    if (!username || !password) return alert("Please fill in username and password.");

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, phoneNumber })
        });
        const data = await res.json();

        if (data.success) {
            showHomeScreen(data.username);
        } else {
            alert(data.message || "Registration failed.");
        }
    } catch (err) {
        alert("Registration failed. Check your network connection.");
    }
}

// Fetch latest balance and load web welcome notification
async function loadUserData(username) {
    try {
        const res = await fetch(`/api/user-details?username=${encodeURIComponent(username)}`);
        const data = await res.json();

        if (data.success && data.user) {
            const user = data.user;
            
            // Update balance in header
            const balanceElem = document.getElementById('balanceDisplay');
            if (balanceElem) balanceElem.innerText = parseFloat(user.balance || 10).toFixed(2);

            // Populate Web Notification Card
            const phone = user.phone_number || "Not Registered";
            const amharicMsg = `ለስለተመዘገብ እናመሰግናለን ${user.username}! 10 ብር ስጦታ አለዎት .\n\n` +
                               `<b>የአካውንት ዝርዝሮች</b>\n` +
                               `ስም: ${user.username}\n` +
                               `ስልክ: ${phone}\n` +
                               `ቀሪ ሒሳብ: ${user.balance || 10} Birr`;

            const notifTextElem = document.getElementById('notifAmharicText');
            if (notifTextElem) notifTextElem.innerHTML = amharicMsg.replace(/\n/g, '<br>');
        }
    } catch (err) {
        console.error("Failed to fetch user details:", err);
    }
}

// Helper function to dynamically add Cloudinary auto-compression flags
function getOptimizedImageUrl(url) {
    if (!url || !url.includes('cloudinary.com')) return url;
    return url.replace('/upload/', '/upload/f_auto,q_auto,w_800/');
}

async function toggleNotificationModal() {
    const modal = document.getElementById('notifModal');
    if (modal) {
        modal.classList.toggle('hidden');
        
        // Fetch fresh notifications if modal is opened
        if (!modal.classList.contains('hidden') && currentUsername) {
            fetchNotifications(currentUsername);

            // Hide the badge visually
            const badge = document.getElementById('notifBadge');
            if (badge) {
                badge.innerText = '0';
                badge.classList.add('hidden');
            }

            // Mark notifications as read on the backend (if your server API supports it)
            try {
                await fetch('/api/notifications/mark-read', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: currentUsername })
                });
            } catch (err) {
                console.error("Failed to mark notifications as read:", err);
            }
        }
    }
}

function renderNotificationsList(notifications) {
    const container = document.getElementById('notifListContainer');
    if (!container) return;

    if (!notifications || notifications.length === 0) {
        container.innerHTML = `<p style="color: #888; text-align: center; padding: 20px 0;">No announcements available.</p>`;
        return;
    }

    container.innerHTML = notifications.map(post => {
        const optimizedUrl = getOptimizedImageUrl(post.image_url);

        return `
            <div style="background: #1e1e28; border: 1px solid #2d2d3f; border-radius: 12px; padding: 14px; margin-bottom: 14px; text-align: left; box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
                ${optimizedUrl ? `<img src="${optimizedUrl}" alt="Post Banner" style="width: 100%; max-height: 350px; object-fit: contain; background: #111; border-radius: 8px; margin-bottom: 10px; border: 1px solid #333;" onerror="this.style.display='none'">` : ''}
                <div style="font-size: 14px; line-height: 1.6; color: #e0e0e0;">${post.message.replace(/\n/g, '<br>')}</div>
                <div style="font-size: 11px; color: #71717a; margin-top: 8px;">📅 ${new Date(post.created_at).toLocaleString()}</div>
            </div>
        `;
    }).join('');
}

function showHomeScreen(username) {
    currentUsername = username;
    localStorage.setItem('bingoUser', username);

    document.getElementById('playerDisplay').innerText = username;
    document.getElementById('headerBar').classList.remove('hidden');
    document.getElementById('bottomNav').classList.remove('hidden');
    document.getElementById('authBox').classList.add('hidden');

    switchTab('tabGames', document.querySelectorAll('.nav-item')[0]);
    document.getElementById('homeBox').classList.remove('hidden');
    document.getElementById('selectionBox').classList.add('hidden');

    // Load balance AND fetch live notifications from server
    loadUserData(username);
    fetchNotifications(username); // <-- ADD THIS LINE
}

window.logoutUser = function() {
    localStorage.removeItem('bingoUser');
    currentUsername = "";
    showAuthBox();
};

async function setWebPassword() {
    const newPassword = document.getElementById('webPasswordInput').value.trim();

    if (!newPassword) return alert("Please enter a password.");

    try {
        const res = await fetch('/api/set-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUsername, newPassword })
        });
        const data = await res.json();

        if (data.success) {
            alert(data.message);
            document.getElementById('webPasswordInput').value = '';
        } else {
            alert(data.message || "Failed to set password.");
        }
    } catch (err) {
        alert("Server error. Could not save password.");
    }
}

// -------------------- NAVIGATION & GAME SELECTION --------------------
function switchTab(tabId, navElement) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));

    const activeTab = document.getElementById(tabId);
    if (activeTab) activeTab.classList.remove('hidden');
    if (navElement) navElement.classList.add('active');
}

async function goToGameScreen() {
    document.getElementById('homeBox').classList.add('hidden');
    document.getElementById('selectionBox').classList.remove('hidden');

    try {
        const res = await fetch('/api/cards/numbers');
        const data = await res.json();
        if (data.success && data.cardNumbers) {
            renderCardNumbers(data.cardNumbers);
        } else {
            showNotification("Failed to load cards. Please try again.");
        }
    } catch (err) {
        console.error("Card fetch error:", err);
        showNotification("Server connection error while loading cards.");
    }
}

function renderCardNumbers(cardNumbers) {
    const gridContainer = document.getElementById('cardGrid');
    if (!gridContainer) return;
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



async function fetchNotifications(username) {
    try {
        const res = await fetch(`/api/notifications?username=${encodeURIComponent(username)}`);
        const data = await res.json();

        if (data.success) {
            const badge = document.getElementById('notifBadge');
            if (badge) {
                if (data.unreadCount > 0) {
                    badge.innerText = data.unreadCount;
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
            renderNotificationsList(data.notifications);
        }
    } catch (err) {
        console.error("Failed to load announcements:", err);
    }
}




function updateSelectedCount() {
    const count = selectedCards.size;
    const countElem = document.getElementById('selectedCount');
    if (countElem) countElem.innerText = count;

    const btn = document.getElementById('playGameBtn');
    if (btn && btn.innerText !== "Waiting for game start...") {
        btn.disabled = count === 0;
    }
}