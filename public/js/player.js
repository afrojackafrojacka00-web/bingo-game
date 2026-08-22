const socket = io();
let currentUsername = localStorage.getItem('bingo_username') || 'Guest';

document.getElementById('userBalance').innerText = '10.00';

socket.emit('join_user_channel', { username: currentUsername });

// Listen for Real-Time Balance Receipts
socket.on('balance_updated', (data) => {
    document.getElementById('userBalance').innerText = data.newBalance.toFixed(2);
    alert(`💰 Balance Update: ${data.amount > 0 ? '+' : ''}${data.amount} ETB (${data.reason})`);
});

// Listen for Broadcast Popups
socket.on('admin_announcement_popup', (data) => {
    const modal = document.getElementById('announcementModal');
    const msg = document.getElementById('popupMessage');
    const img = document.getElementById('popupImage');

    msg.innerText = data.message;
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

socket.on('timer_tick', (data) => {
    document.getElementById('timer').innerText = data.timer;
});