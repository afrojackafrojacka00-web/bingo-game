const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { pool, initDB } = require('./config/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

initDB();

// Subdomain Middleware Routing
app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (host.startsWith('admin.')) {
        if (req.path === '/') {
            return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
        }
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Modular API Routes
app.use('/api', require('./routes/auth.routes'));
app.use('/api', require('./routes/game.routes'));
app.use('/api/admin', require('./routes/admin.routes')(io));

// Modular WebSockets
require('./sockets/notificationSocket').initNotificationSocket(io);
require('./sockets/gameSocket')(io, pool);

server.listen(PORT, () => console.log(`Server live on port ${PORT}`));