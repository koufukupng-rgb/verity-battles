const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// Arquivo local para salvar os dados dos jogadores por IP / ID único
const DATA_FILE = path.join(__dirname, 'database.json');
let db = {};
if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE)); } catch(e) { db = {}; }
}
function saveDB() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

let players = {};
let matchQueue = { '1v1': [], '2v2': [] };
let obstacles = [
    { x: 300, y: 200, w: 200, h: 40 },
    { x: 150, y: 400, w: 60, h: 120 },
    { x: 600, y: 350, w: 80, h: 80 }
];

io.on('connection', (socket) => {
    // Pega o IP real do cliente para criar um ID único persistente
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const userId = clientIp.replace(/[:.]/g, '_');

    console.log(`Conexão estabelecida: Socket ${socket.id} | UserID: ${userId}`);

    // Carrega ou inicializa dados salvos do jogador
    if (!db[userId]) {
        db[userId] = {
            id: userId,
            name: "Verity Player",
            email: "",
            avatar: "verity.png",
            coins: 100,
            elo: 1000,
            speed: 4,
            damage: 25,
            hp: 100,
            maxHp: 100,
            sword: "Padrão",
            unlockedSwords: ["Padrão"]
        };
        saveDB();
    }

    players[socket.id] = {
        socketId: socket.id,
        userId: userId,
        x: Math.random() * 600 + 100,
        y: Math.random() * 400 + 100,
        radius: 32,
        speed: db[userId].speed,
        hp: db[userId].hp,
        maxHp: db[userId].maxHp,
        coins: db[userId].coins,
        damage: db[userId].damage,
        elo: db[userId].elo,
        name: db[userId].name,
        avatar: db[userId].avatar,
        sword: db[userId].sword,
        unlockedSwords: db[userId].unlockedSwords,
        swordAngle: 0,
        classType: 'Verity',
        inMatch: false
    };

    socket.emit('init', { id: socket.id, playerData: db[userId], obstacles });

    // Login com Email / Google simulado
    socket.on('login', (data) => {
        if (data.email) {
            db[userId].email = data.email;
            db[userId].name = data.name || data.email.split('@')[0];
            if(data.avatar) db[userId].avatar = data.avatar;
            saveDB();
            players[socket.id].name = db[userId].name;
            players[socket.id].avatar = db[userId].avatar;
            socket.emit('loginSuccess', db[userId]);
        }
    });

    // Entrar na fila de Matchmaking
    socket.on('joinQueue', (mode) => {
        if (!matchQueue[mode]) matchQueue[mode] = [];
        if (!matchQueue[mode].includes(socket.id)) {
            matchQueue[mode].push(socket.id);
            socket.emit('inQueue', mode);
            checkMatchmaking(mode);
        }
    });

    socket.on('leaveQueue', (mode) => {
        if (matchQueue[mode]) {
            matchQueue[mode] = matchQueue[mode].filter(id => id !== socket.id);
        }
    });

    // Movimentação em tempo real
    socket.on('move', (data) => {
        const p = players[socket.id];
        if (!p || p.hp <= 0) return;

        if (data.up) p.y -= p.speed;
        if (data.down) p.y += p.speed;
        if (data.left) p.x -= p.speed;
        if (data.right) p.x += p.speed;

        p.x = Math.max(p.radius, Math.min(800 - p.radius, p.x));
        p.y = Math.max(p.radius, Math.min(600 - p.radius, p.y));

        // Atualiza ângulo contínuo da espada para orbitar perfeitamente
        p.swordAngle += 0.08;
    });

    // Compras na Loja (Upgrades e Espadas caras para grind)
    socket.on('upgrade', (type) => {
        const p = players[socket.id];
        const u = db[userId];
        if (!p || !u) return;

        if (type === 'speed' && u.coins >= 150) {
            u.coins -= 150;
            p.speed += 0.5;
            u.speed = p.speed;
        } else if (type === 'damage' && u.coins >= 300) {
            u.coins -= 300;
            p.damage += 15;
            u.damage = p.damage;
        } else if (type === 'heal' && u.coins >= 75) {
            u.coins -= 75;
            p.hp = p.maxHp;
        }
        saveDB();
        socket.emit('updateStats', u);
    });

    socket.on('buySword', (data) => {
        const p = players[socket.id];
        const u = db[userId];
        if (!p || !u) return;

        if (!u.unlockedSwords.includes(data.name) && u.coins >= data.cost) {
            u.coins -= data.cost;
            u.unlockedSwords.push(data.name);
            u.sword = data.name;
            p.sword = data.name;
            saveDB();
            socket.emit('updateStats', u);
        } else if (u.unlockedSwords.includes(data.name)) {
            u.sword = data.name;
            p.sword = data.name;
            saveDB();
            socket.emit('updateStats', u);
        }
    });

    socket.on('disconnect', () => {
        for (let m in matchQueue) {
            matchQueue[m] = matchQueue[m].filter(id => id !== socket.id);
        }
        delete players[socket.id];
        console.log(`Desconectado: ${socket.id}`);
    });
});

function checkMatchmaking(mode) {
    let req = mode === '1v1' ? 2 : 4;
    if (matchQueue[mode].length >= req) {
        let matchedIds = matchQueue[mode].splice(0, req);
        matchedIds.forEach(id => {
            if (players[id]) {
                players[id].inMatch = true;
                io.to(id).emit('matchFound', mode);
            }
        });
    }
}

// Loop de combate e física de colisão das espadas orbitais gigantes
setInterval(() => {
    let playerIds = Object.keys(players);
    for (let i = 0; i < playerIds.length; i++) {
        for (let j = i + 1; j < playerIds.length; j++) {
            let p1 = players[playerIds[i]];
            let p2 = players[playerIds[j]];
            if (!p1 || !p2) continue;

            // Calcula posição da espada orbital do P1
            let orbit1 = p1.radius + 38;
            let sword1X = p1.x + Math.cos(p1.swordAngle) * orbit1;
            let sword1Y = p1.y + Math.sin(p1.swordAngle) * orbit1;

            // Calcula posição da espada orbital do P2
            let orbit2 = p2.radius + 38;
            let sword2X = p2.x + Math.cos(p2.swordAngle) * orbit2;
            let sword2Y = p2.y + Math.sin(p2.swordAngle) * orbit2;

            // Espada de P1 atinge P2
            let dist12 = Math.hypot(sword1X - p2.x, sword1Y - p2.y);
            if (dist12 < p2.radius + 20) {
                p2.hp -= 0.8;
            }

            // Espada de P2 atinge P1
            let dist21 = Math.hypot(sword2X - p1.x, sword2Y - p1.y);
            if (dist21 < p1.radius + 20) {
                p1.hp -= 0.8;
            }
        }
    }

    // Gerencia mortes, grind de moedas e Elo
    for (let id in players) {
        let p = players[id];
        if (p.hp <= 0) {
            p.hp = p.maxHp;
            p.x = Math.random() * 600 + 100;
            p.y = Math.random() * 400 + 100;
            p.elo = Math.max(100, p.elo - 15);
            db[p.userId].elo = p.elo;
            saveDB();
        } else {
            // Ganha moedas gradativamente por sobrevivência na arena (Grind)
            if (Math.random() < 0.05) {
                p.coins += 1;
                db[p.userId].coins = p.coins;
                saveDB();
                io.to(p.socketId).emit('updateStats', db[p.userId]);
            }
        }
    }

    io.emit('updatePlayers', players);
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
