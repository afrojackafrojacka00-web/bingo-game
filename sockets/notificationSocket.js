async function notifyBalanceChange(pool, io, userId, username, changeAmount, newBalance, reasonType) {
    try {
        await pool.query(
            'INSERT INTO transactions (user_id, amount, type) VALUES ($1, $2, $3)',
            [userId, changeAmount, reasonType]
        );

        io.to(`user_${username.toLowerCase()}`).emit('balance_updated', {
            amount: parseFloat(changeAmount),
            newBalance: parseFloat(newBalance),
            reason: reasonType,
            timestamp: new Date()
        });

        const userRes = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [userId]);
        const telegramId = userRes.rows[0]?.telegram_id;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        if (telegramId && botToken) {
            const text = `💰 **ሒሳብ ተቀይሯል / Balance Update**\n\n` +
                         `ምክንያት: ${reasonType}\n` +
                         `መጠን: ${changeAmount > 0 ? '+' : ''}${changeAmount} ETB\n` +
                         `አሁን ያለዎት ቀሪ ሒሳብ: ${parseFloat(newBalance).toFixed(2)} ETB`;

            fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: telegramId, text: text, parse_mode: 'Markdown' })
            }).catch(err => console.error("Failed to send Telegram notification:", err));
        }
    } catch (err) {
        console.error("Error sending balance notification:", err);
    }
}

function initNotificationSocket(io) {
    io.on('connection', (socket) => {
        socket.on('join_user_channel', ({ username }) => {
            if (username) {
                socket.join(`user_${username.toLowerCase()}`);
            }
        });
    });
}

module.exports = { initNotificationSocket, notifyBalanceChange };