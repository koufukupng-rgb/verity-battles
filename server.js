const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const players = {};
const arenaSize = { width: 800, height: 600 };

io.on('connection', (socket) => {
    console.log(`Novo Verity conectado: ${socket.id}`);

    players[socket.id] = {
        id: socket.id,
        x: Math.random() * 600 + 100,
        y: Math.random() * 400 + 100,
        radius: 30,
        vx: 0,
        vy: 0,
        speed: 4,
        hp: 100,
        maxHp: 100,
        coins: 0,
        damage: 10,
        color: '#' + Math.floor(Math.random()*16777215).toString(16)
    };

    socket.emit('init', { id: socket.id, players, arenaSize });

    socket.on('move', (data) => {
        const player = players[socket.id];
        if (!player || player.hp <= 0) return;

        if (data.up) player.y -= player.speed;
        if (data.down) player.y += player.speed;
        if (data.left) player.x -= player.speed;
        if (data.right) player.x += player.speed;

        player.x = Math.max(player.radius, Math.min(arenaSize.width - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(arenaSize.height - player.radius, player.y));
    });

    socket.on('upgrade', (type) => {
        const player = players[socket.id];
        if (!player) return;

        if (type === 'speed' && player.coins >= 10) {
            player.coins -= 10;
            player.speed += 1;
        } else if (type === 'damage' && player.coins >= 15) {
            player.coins -= 15;
            player.damage += 5;
        } else if (type === 'heal' && player.coins >= 5) {
            player.coins -= 5;
            player.hp = Math.min(player.maxHp, player.hp + 30);
        }
        io.emit('updatePlayers', players);
    });

    socket.on('disconnect', () => {
        console.log(`Verity desconectado: ${socket.id}`);
        delete players[socket.id];
        io.emit('updatePlayers', players);
    });
});

setInterval(() => {
    const playerIds = Object.keys(players);
    for (let i = 0; i < playerIds.length; i++) {
        for (let j = i + 1; j < playerIds.length; j++) {
            let p1 = players[playerIds[i]];
            let p2 = players[playerIds[j]];

            let dx = p2.x - p1.x;
            let dy = p2.y - p1.y;
            let dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < p1.radius + p2.radius) {
                p1.hp -= 0.5;
                p2.hp -= 0.5;
                if (Math.random() < 0.1) p1.coins += 1;
                if (Math.random() < 0.1) p2.coins += 1;
            }
        }
    }

    for (let id in players) {
        if (players[id].hp <= 0) {
            players[id].hp = players[id].maxHp;
            players[id].x = Math.random() * 600 + 100;
            players[id].y = Math.random() * 400 + 100;
        }
    }

    io.emit('updatePlayers', players);
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
