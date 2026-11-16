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
    "Verity": { cost: 0, currency: 'coins' },
    "Moggity": { cost: 1000, currency: 'coins' },
    "Lovity": { cost: 1800, currency: 'coins', speedMult: 1.55 },
    "Falsity": { cost: 150, currency: 'verityCoins' },
    "CyberNinja": { cost: 2500, currency: 'coins' }
};

const MENU_STYLES = {
    "Windows 7": { rarity: "Padrão" },
    "Windows XP": { rarity: "Lendário Raro (0.1%)" },
    "Windows 10": { rarity: "Épico (1%)" },
    "Windows 11": { rarity: "Raro (5%)" },
    "Hacker": { rarity: "Incomum (10%)" },
    "Neo Cyber": { rarity: "Raro (7%)" }
};

const FREE_MAP = {
    name: "Mega Labirinto Livre Gigante",
    width: 4000,
    height: 3000,
    obstacles: [
        { x: 300, y: 300, w: 800, h: 120 },
        { x: 1400, y: 200, w: 180, h: 900 },
        { x: 1900, y: 500, w: 700, h: 150 },
        { x: 2900, y: 300, w: 250, h: 700 },
        { x: 400, y: 1000, w: 600, h: 200 },
        { x: 1200, y: 1300, w: 500, h: 250 },
        { x: 2000, y: 1100, w: 200, h: 800 },
        { x: 2600, y: 1400, w: 800, h: 180 },
        { x: 300, y: 1800, w: 700, h: 250 },
        { x: 1100, y: 2000, w: 900, h: 180 },
        { x: 2300, y: 2100, w: 350, h: 500 },
        { x: 3000, y: 1900, w: 700, h: 200 },
        { x: 600, y: 2500, w: 500, h: 200 },
        { x: 1500, y: 2400, w: 600, h: 220 }
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

function isDevUser(socketId) {
    const email = onlineSockets[socketId];
    return email === 'koufukupng@gmail.com';
}

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
            equippedSword: "Espada Básica",
            unlockedSwords: ["Espada Básica"],
            equippedMenuStyle: "Windows 7",
            unlockedMenuStyles: ["Windows 7"],
            coins: 400,
            verityCoins: 10,
            level: 1,
            xp: 0,
            wins: 0, losses: 0,
            speedLvl: 1, hpLvl: 1
        };

        db.users[email] = newUser;
        db.usernames[lowerUser] = email;
        saveDB();

        userActiveSocket[email] = socket.id;
        onlineSockets[socket.id] = email;
        socket.emit('authSuccess', newUser);
    });

    // MODO DEV (Seguro por Backend)
    socket.on('devAddCoins', (amount) => {
        if (!isDevUser(socket.id)) return socket.emit('shopError', 'Acesso negado.');
        const user = db.users[onlineSockets[socket.id]];
        if (user) { user.coins += (amount || 1000); saveDB(); socket.emit('userUpdated', user); }
    });

    socket.on('devAddVerityCoins', (amount) => {
        if (!isDevUser(socket.id)) return socket.emit('shopError', 'Acesso negado.');
        const user = db.users[onlineSockets[socket.id]];
        if (user) { user.verityCoins = (user.verityCoins || 0) + (amount || 50); saveDB(); socket.emit('userUpdated', user); }
    });

    socket.on('devUnlockEverything', () => {
        if (!isDevUser(socket.id)) return socket.emit('shopError', 'Acesso negado.');
        const user = db.users[onlineSockets[socket.id]];
        if (user) {
            user.unlockedSwords = Object.keys(SWORDS);
            user.unlockedClasses = Object.keys(CLASSES);
            user.unlockedMenuStyles = Object.keys(MENU_STYLES);
            user.coins += 50000;
            user.verityCoins += 1000;
            saveDB();
            socket.emit('userUpdated', user);
            socket.emit('shopError', '🛠️ MODO DEV: Tudo liberado com sucesso!');
        }
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

    socket.on('selectSword', (swordName) => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        if (user && user.unlockedSwords && user.unlockedSwords.includes(swordName)) {
            user.equippedSword = swordName;
            saveDB();
            socket.emit('userUpdated', user);
        }
    });

    socket.on('selectMenuStyle', (styleName) => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        if (user && user.unlockedMenuStyles && user.unlockedMenuStyles.includes(styleName)) {
            user.equippedMenuStyle = styleName;
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
        
        if (!user.unlockedClasses.includes(clsName)) {
            if (clsInfo.currency === 'verityCoins') {
                if (user.verityCoins >= clsInfo.cost) {
                    user.verityCoins -= clsInfo.cost;
                    user.unlockedClasses.push(clsName);
                    user.selectedClass = clsName;
                    saveDB();
                    socket.emit('userUpdated', user);
                } else {
                    socket.emit('shopError', 'Verity Coins insuficientes!');
                }
            } else {
                if (user.coins >= clsInfo.cost) {
                    user.coins -= clsInfo.cost;
                    user.unlockedClasses.push(clsName);
                    user.selectedClass = clsName;
                    saveDB();
                    socket.emit('userUpdated', user);
                } else {
                    socket.emit('shopError', 'Moedas insuficientes!');
                }
            }
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

    socket.on('openThemeBox', () => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        if (!user || user.coins < 200) return socket.emit('boxError', 'Você precisa de 200 moedas!');

        user.coins -= 200;

        const rollPool = [
            { name: "Windows XP", chance: 0.001, type: 'menu' },
            { name: "Windows 10", chance: 0.01, type: 'menu' },
            { name: "Windows 11", chance: 0.05, type: 'menu' },
            { name: "Neo Cyber", chance: 0.07, type: 'menu' },
            { name: "Hacker", chance: 0.10, type: 'menu' },
            { name: "Windows 7", chance: 0.769, type: 'menu' }
        ];

        let rand = Math.random();
        let cumulative = 0;
        let selectedTheme = "Windows 7";

        for (let item of rollPool) {
            cumulative += item.chance;
            if (rand <= cumulative) {
                selectedTheme = item.name;
                break;
            }
        }

        if (!user.unlockedMenuStyles.includes(selectedTheme)) {
            user.unlockedMenuStyles.push(selectedTheme);
        } else {
            user.coins += 100;
        }

        saveDB();
        socket.emit('themeBoxOpened', { prize: selectedTheme, user });
    });

    socket.on('joinFreeRoam', () => {
        const email = onlineSockets[socket.id];
        const u = db.users[email];
        if (!u || Object.keys(freeRoamPlayers).length >= 25) return;
        const sword = SWORDS[u.equippedSword] || SWORDS["Espada Básica"];
        let baseSpeed = u.selectedClass === 'Lovity' ? 5.0 * 1.55 : 5.0;

        freeRoamPlayers[socket.id] = {
            socketId: socket.id, username: u.username, profilePic: u.profilePic,
            selectedClass: u.selectedClass, x: Math.random() * 3600 + 200, y: Math.random() * 2600 + 200,
            radius: 34, hp: 100, maxHp: 100, speed: baseSpeed, swordSpeed: 0.1, swordLength: sword.length,
            swordAngle: 0, keys: { up: false, down: false, left: false, right: false }, dashCooldown: 0,
            lovityAngle: 0
        };
        socket.emit('freeRoamStart', { map: FREE_MAP, players: freeRoamPlayers });
    });

    socket.on('freeRoamInput', (data) => {
        if (freeRoamPlayers[socket.id]) freeRoamPlayers[socket.id].keys = data.keys;
    });

    socket.on('freeRoamDash', () => {
        const p = freeRoamPlayers[socket.id];
        if (p && p.selectedClass === 'Moggity' && p.dashCooldown <= 0) {
            p.x += Math.cos(p.swordAngle) * 110;
            p.y += Math.sin(p.swordAngle) * 110;
            p.dashCooldown = 35;
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
                p.x += Math.cos(p.swordAngle) * 100;
                p.y += Math.sin(p.swordAngle) * 100;
                p.dashCooldown = 40;
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
        let baseSpeed = u.selectedClass === 'Lovity' ? 4.5 * 1.55 : 4.5;

        room.players[sockId] = {
            socketId: sockId, email: u.email, username: u.username, profilePic: u.profilePic,
            selectedClass: u.selectedClass || 'Verity', team,
            x: team === 1 ? 80 : map.width - 80, y: (map.height / (needed / 2 + 1)) * (Math.floor(idx / 2) + 1),
            radius: 34, hp: 100, maxHp: 100, speed: baseSpeed, swordDamage: sword.damage,
            swordLength: sword.length, swordSpeed: 0.1, swordAngle: team === 1 ? 0 : Math.PI,
            hitCooldown: 0, dashCooldown: 0, keys: { up: false, down: false, left: false, right: false },
            lovityAngle: 0
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
        if (p.selectedClass === 'Lovity') p.lovityAngle = (p.lovityAngle + 0.08) % (Math.PI * 2);
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
            if (p.selectedClass === 'Lovity') p.lovityAngle = (p.lovityAngle + 0.08) % (Math.PI * 2);
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
                    a.hitCooldown = 15;
                }

                if (a.selectedClass === 'Lovity') {
                    let heartDist = a.radius + 35;
                    let hX = a.x + Math.cos(a.lovityAngle) * heartDist;
                    let hY = a.y + Math.sin(a.lovityAngle) * heartDist;
                    if (Math.hypot(hX - b.x, hY - b.y) < b.radius + 10 && a.hitCooldown <= 0) {
                        b.hp = Math.max(0, b.hp - 6);
                    }
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

            winners.forEach(w => {
                let u = db.users[w.email];
                if(u) {
                    u.coins += 120; u.wins++;
                    u.xp += 150;
                    if (u.xp >= u.level * 300) { u.xp -= u.level * 300; u.level++; }
                }
            });
            losers.forEach(l => {
                let u = db.users[l.email];
                if(u) {
                    u.losses++;
                    u.xp += 50;
                    if (u.xp >= u.level * 300) { u.xp -= u.level * 300; u.level++; }
                }
            });
            saveDB();

            pList.forEach(p => {
                const won = p.team === winningTeam;
                io.to(p.socketId).emit('matchEnd', {
                    won, username: p.username, profilePic: p.profilePic,
                    opponentNames: (won ? losers : winners).map(o => o.username).join(', '),
                    xpEarned: won ? 150 : 50, coinsEarned: won ? 120 : 0, user: db.users[p.email]
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
