const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'database.json');
let db = { users: {}, usernames: {} };

if (fs.existsSync(DATA_FILE)) {
    try {
        const loaded = JSON.parse(fs.readFileSync(DATA_FILE));
        if (loaded.users) db = loaded;
    } catch (e) { db = { users: {}, usernames: {} }; }
}

function saveDB() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

const SWORDS = {
    "Espada Básica": { damage: 12, speedMult: 1.0, length: 46, cost: 0, png: "espada.png" },
    "Lâmina de Cobalto": { damage: 18, speedMult: 1.15, length: 52, cost: 400, png: "cobalto.png" },
    "Katana Solar": { damage: 25, speedMult: 1.35, length: 58, cost: 1200, png: "katana.png" },
    "Foice do Abismo": { damage: 38, speedMult: 1.25, length: 66, cost: 3500, png: "foice.png" }
};

const CLASSES = {
    "Verity": { cost: 0 },
    "Moggity": { cost: 1000 },
    "CyberNinja": { cost: 2500 }
};

const FREE_MAP = {
    name: "Arena Livre Gigante",
    width: 2000,
    height: 1500,
    obstacles: [
        { x: 500, y: 400, w: 300, h: 80 },
        { x: 1200, y: 300, w: 100, h: 400 },
        { x: 800, y: 900, w: 400, h: 100 },
        { x: 300, y: 1100, w: 200, h: 200 },
        { x: 1500, y: 1000, w: 250, h: 150 }
    ]
};

const MAPS = [
    {
        name: "Arena Clássica", width: 800, height: 600,
        obstacles: [
            { x: 300, y: 180, w: 200, h: 35 }, { x: 300, y: 385, w: 200, h: 35 },
            { x: 140, y: 240, w: 35, h: 120 }, { x: 625, y: 240, w: 35, h: 120 }
        ]
    }
];

let onlineSockets = {};
let userActiveSocket = {};
let matchQueue = { '1v1': [], '2v2': [] };
let activeRooms = {};
let freeRoamPlayers = {};

function resolveCircleRect(p, obs) {
    let closestX = Math.max(obs.x, Math.min(p.x, obs.x + obs.w));
    let closestY = Math.max(obs.y, Math.min(p.y, obs.y + obs.h));
    let dx = p.x - closestX, dy = p.y - closestY;
    let distSq = dx * dx + dy * dy;
    if (distSq < p.radius * p.radius) {
        let dist = Math.sqrt(distSq);
        if (dist === 0) p.x += p.radius;
        else {
            let overlap = p.radius - dist;
            p.x += (dx / dist) * overlap;
            p.y += (dy / dist) * overlap;
        }
    }
}

io.on('connection', (socket) => {
    socket.on('auth', (data) => {
        const email = (data.email || '').trim().toLowerCase();
        const password = (data.password || '').trim();
        const username = (data.username || '').trim();
        const isGoogle = !!data.isGoogle;

        if (!email) return socket.emit('authError', 'Informe um e-mail válido.');
        if (!isGoogle && (!username || !password)) return socket.emit('authError', 'Preencha Username, E-mail e Senha.');

        const defaultEmailAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${email}`;

        if (db.users[email]) {
            const user = db.users[email];
            if (!isGoogle) {
                if (user.password === 'GOOGLE_OAUTH') return socket.emit('authError', 'Conta criada com Google.');
                if (user.password !== password) return socket.emit('authError', 'Senha incorreta.');
            }
            if (userActiveSocket[email] && userActiveSocket[email] !== socket.id) {
                io.to(userActiveSocket[email]).emit('forceLogout', 'Você se conectou em outro dispositivo.');
            }
            userActiveSocket[email] = socket.id;
            onlineSockets[socket.id] = email;
            return socket.emit('authSuccess', user);
        }

        let finalUsername = username || (data.googleName ? data.googleName.replace(/\s+/g, '') : email.split('@')[0]);
        let lowerUser = finalUsername.toLowerCase();
        if (db.usernames[lowerUser]) {
            if (isGoogle) finalUsername += Math.floor(100 + Math.random() * 900);
            else return socket.emit('authError', `Username "${finalUsername}" já em uso.`);
        }

        const newUser = {
            email,
            password: isGoogle ? 'GOOGLE_OAUTH' : password,
            username: finalUsername,
            profilePic: data.googleAvatar || defaultEmailAvatar,
            selectedClass: 'Verity',
            unlockedClasses: ['Verity'],
            customAvatar: null,
            coins: 200,
            elo: 1000,
            wins: 0, losses: 0,
            speedLvl: 1, hpLvl: 1,
            equippedSword: "Espada Básica",
            unlockedSwords: ["Espada Básica"]
        };

        db.users[email] = newUser;
        db.usernames[lowerUser] = email;
        saveDB();

        userActiveSocket[email] = socket.id;
        onlineSockets[socket.id] = email;
        socket.emit('authSuccess', newUser);
    });

    socket.on('selectClass', (cls) => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        if (user && user.unlockedClasses && user.unlockedClasses.includes(cls)) {
            user.selectedClass = cls;
            saveDB();
            socket.emit('userUpdated', user);
        }
    });

    socket.on('buyClass', (clsName) => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        const clsInfo = CLASSES[clsName];
        if (!user || !clsInfo) return;
        if (!user.unlockedClasses) user.unlockedClasses = ['Verity'];
        if (!user.unlockedClasses.includes(clsName) && user.coins >= clsInfo.cost) {
            user.coins -= clsInfo.cost;
            user.unlockedClasses.push(clsName);
            user.selectedClass = clsName;
            saveDB();
            socket.emit('userUpdated', user);
        }
    });

    socket.on('shopSword', (swordName) => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        const sword = SWORDS[swordName];
        if (!user || !sword) return;
        if (user.unlockedSwords.includes(swordName)) {
            user.equippedSword = swordName;
            saveDB(); socket.emit('userUpdated', user);
        } else if (user.coins >= sword.cost) {
            user.coins -= sword.cost;
            user.unlockedSwords.push(swordName);
            user.equippedSword = swordName;
            saveDB(); socket.emit('userUpdated', user);
        }
    });

    socket.on('shopUpgrade', (type) => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        if (!user) return;
        if (type === 'speed' && user.speedLvl < 10 && user.coins >= user.speedLvl * 200) {
            user.coins -= user.speedLvl * 200; user.speedLvl++; saveDB(); socket.emit('userUpdated', user);
        } else if (type === 'hp' && user.hpLvl < 10 && user.coins >= user.hpLvl * 200) {
            user.coins -= user.hpLvl * 200; user.hpLvl++; saveDB(); socket.emit('userUpdated', user);
        }
    });

    socket.on('changePassword', (data) => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        if (!user) return;
        if (user.password === 'GOOGLE_OAUTH') return socket.emit('settingsFeedback', { ok: false, msg: 'Contas Google não usam senha.' });
        if (user.password !== data.oldPass) return socket.emit('settingsFeedback', { ok: false, msg: 'Senha atual incorreta.' });
        user.password = data.newPass;
        saveDB();
        socket.emit('settingsFeedback', { ok: true, msg: 'Senha alterada com sucesso!' });
    });

    socket.on('joinFreeRoam', () => {
        const email = onlineSockets[socket.id];
        const u = db.users[email];
        if (!u || Object.keys(freeRoamPlayers).length >= 25) return;
        const sword = SWORDS[u.equippedSword] || SWORDS["Espada Básica"];

        freeRoamPlayers[socket.id] = {
            socketId: socket.id, username: u.username, profilePic: u.profilePic,
            selectedClass: u.selectedClass, x: Math.random() * 1800 + 100, y: Math.random() * 1300 + 100,
            radius: 34, hp: 100, maxHp: 100, speed: 4.5, swordSpeed: 0.09, swordLength: sword.length,
            swordAngle: 0, keys: { up: false, down: false, left: false, right: false }, dashCooldown: 0
        };
        socket.emit('freeRoamStart', { map: FREE_MAP, players: freeRoamPlayers });
    });

    socket.on('freeRoamInput', (data) => {
        if (freeRoamPlayers[socket.id]) freeRoamPlayers[socket.id].keys = data.keys;
    });

    socket.on('freeRoamDash', () => {
        const p = freeRoamPlayers[socket.id];
        if (p && p.selectedClass === 'Moggity' && p.dashCooldown <= 0) {
            p.x += Math.cos(p.swordAngle) * 90;
            p.y += Math.sin(p.swordAngle) * 90;
            p.dashCooldown = 45;
        }
    });

    socket.on('joinQueue', (mode) => {
        const email = onlineSockets[socket.id];
        if (!email || !db.users[email]) return;
        matchQueue['1v1'] = matchQueue['1v1'].filter(id => id !== socket.id);
        matchQueue['2v2'] = matchQueue['2v2'].filter(id => id !== socket.id);
        matchQueue[mode].push(socket.id);
        tryCreateMatch(mode);
    });

    socket.on('leaveQueue', () => {
        matchQueue['1v1'] = matchQueue['1v1'].filter(id => id !== socket.id);
        matchQueue['2v2'] = matchQueue['2v2'].filter(id => id !== socket.id);
    });

    socket.on('playerInput', (data) => {
        const room = activeRooms[data.roomId];
        if (room && room.players[socket.id]) room.players[socket.id].keys = data.keys;
    });

    socket.on('playerDash', (roomId) => {
        const room = activeRooms[roomId];
        if (room && room.players[socket.id]) {
            let p = room.players[socket.id];
            if (p.selectedClass === 'Moggity' && p.dashCooldown <= 0) {
                p.x += Math.cos(p.swordAngle) * 85;
                p.y += Math.sin(p.swordAngle) * 85;
                p.dashCooldown = 50;
            }
        }
    });

    socket.on('disconnect', () => {
        delete freeRoamPlayers[socket.id];
        matchQueue['1v1'] = matchQueue['1v1'].filter(id => id !== socket.id);
        matchQueue['2v2'] = matchQueue['2v2'].filter(id => id !== socket.id);
        for (let roomId in activeRooms) {
            if (activeRooms[roomId].players[socket.id]) activeRooms[roomId].players[socket.id].hp = 0;
        }
        delete onlineSockets[socket.id];
    });
});

function tryCreateMatch(mode) {
    const needed = mode === '1v1' ? 2 : 4;
    if (matchQueue[mode].length < needed) return;
    const selected = matchQueue[mode].splice(0, needed);
    const roomId = 'room_' + Date.now();
    const map = MAPS[0];

    let room = { id: roomId, mode, map, players: {}, state: 'playing' };
    selected.forEach((sockId, idx) => {
        const email = onlineSockets[sockId];
        const u = db.users[email];
        const team = (idx % 2 === 0) ? 1 : 2;
        const sword = SWORDS[u.equippedSword] || SWORDS["Espada Básica"];

        room.players[sockId] = {
            socketId: sockId, email: u.email, username: u.username, profilePic: u.profilePic,
            selectedClass: u.selectedClass || 'Verity', elo: u.elo, team,
            x: team === 1 ? 80 : map.width - 80, y: (map.height / (needed / 2 + 1)) * (Math.floor(idx / 2) + 1),
            radius: 34, hp: 100, maxHp: 100, speed: 4.2, swordDamage: sword.damage,
            swordLength: sword.length, swordSpeed: 0.09, swordAngle: team === 1 ? 0 : Math.PI,
            hitCooldown: 0, dashCooldown: 0, keys: { up: false, down: false, left: false, right: false }
        };
        io.sockets.sockets.get(sockId)?.join(roomId);
    });
    activeRooms[roomId] = room;
    io.to(roomId).emit('matchStart', { roomId, mode, map, players: room.players });
}

setInterval(() => {
    for (let id in freeRoamPlayers) {
        let p = freeRoamPlayers[id];
        let vx = 0, vy = 0;
        if (p.keys.up) vy -= 1; if (p.keys.down) vy += 1;
        if (p.keys.left) vx -= 1; if (p.keys.right) vx += 1;
        if (vx !== 0 && vy !== 0) { vx *= Math.SQRT1_2; vy *= Math.SQRT1_2; }
        p.x = Math.max(p.radius, Math.min(FREE_MAP.width - p.radius, p.x + vx * p.speed));
        p.y = Math.max(p.radius, Math.min(FREE_MAP.height - p.radius, p.y + vy * p.speed));
        for (let obs of FREE_MAP.obstacles) resolveCircleRect(p, obs);
        p.swordAngle = (p.swordAngle + p.swordSpeed) % (Math.PI * 2);
        if (p.dashCooldown > 0) p.dashCooldown--;
    }
    io.emit('freeRoamState', freeRoamPlayers);

    for (let roomId in activeRooms) {
        const room = activeRooms[roomId];
        if (room.state !== 'playing') continue;
        const pList = Object.values(room.players);

        for (let p of pList) {
            if (p.hp <= 0) continue;
            let vx = 0, vy = 0;
            if (p.keys.up) vy -= 1; if (p.keys.down) vy += 1;
            if (p.keys.left) vx -= 1; if (p.keys.right) vx += 1;
            if (vx !== 0 && vy !== 0) { vx *= Math.SQRT1_2; vy *= Math.SQRT1_2; }
            p.x = Math.max(p.radius, Math.min(room.map.width - p.radius, p.x + vx * p.speed));
            p.y = Math.max(p.radius, Math.min(room.map.height - p.radius, p.y + vy * p.speed));
            for (let obs of room.map.obstacles) resolveCircleRect(p, obs);
            p.swordAngle = (p.swordAngle + p.swordSpeed) % (Math.PI * 2);
            if (p.hitCooldown > 0) p.hitCooldown--;
            if (p.dashCooldown > 0) p.dashCooldown--;
        }

        for (let i = 0; i < pList.length; i++) {
            for (let j = 0; j < pList.length; j++) {
                if (i === j) continue;
                let a = pList[i], b = pList[j];
                if (a.hp <= 0 || b.hp <= 0 || a.team === b.team) continue;
                let tipDist = a.radius + a.swordLength;
                let tipX = a.x + Math.cos(a.swordAngle) * tipDist;
                let tipY = a.y + Math.sin(a.swordAngle) * tipDist;
                if (Math.hypot(tipX - b.x, tipY - b.y) < b.radius && a.hitCooldown <= 0) {
                    b.hp = Math.max(0, b.hp - a.swordDamage);
                    a.hitCooldown = 18;
                }
            }
        }

        const t1 = pList.some(p => p.team === 1 && p.hp > 0);
        const t2 = pList.some(p => p.team === 2 && p.hp > 0);
        if (!t1 || !t2) {
            room.state = 'finished';
            const winningTeam = t1 ? 1 : 2;
            const winners = pList.filter(p => p.team === winningTeam);
            const losers = pList.filter(p => p.team !== winningTeam);

            winners.forEach(w => { let u = db.users[w.email]; if(u){u.elo+=25; u.coins+=120; u.wins++;} });
            losers.forEach(l => { let u = db.users[l.email]; if(u){u.elo=Math.max(100,u.elo-25); u.losses++;} });
            saveDB();

            pList.forEach(p => {
                const won = p.team === winningTeam;
                io.to(p.socketId).emit('matchEnd', {
                    won, username: p.username, profilePic: p.profilePic,
                    opponentNames: (won ? losers : winners).map(o => o.username).join(', '),
                    eloDelta: won ? 25 : -25, coinsEarned: won ? 120 : 0, user: db.users[p.email]
                });
            });
            delete activeRooms[roomId];
        } else {
            io.to(roomId).emit('roomState', room.players);
        }
    }
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
