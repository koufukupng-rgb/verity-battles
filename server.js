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
    } catch (e) {
        db = { users: {}, usernames: {} };
    }
}

function saveDB() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// Definição de múltiplos mapas (tamanhos e paredes diferentes)
const MAPS = [
    {
        name: "Arena Clássica",
        width: 800,
        height: 600,
        obstacles: [
            { x: 300, y: 180, w: 200, h: 35 },
            { x: 300, y: 385, w: 200, h: 35 },
            { x: 140, y: 240, w: 35, h: 120 },
            { x: 625, y: 240, w: 35, h: 120 }
        ]
    },
    {
        name: "Jaula Frenética (Pequeno)",
        width: 600,
        height: 450,
        obstacles: [
            { x: 260, y: 185, w: 80, h: 80 }
        ]
    },
    {
        name: "Coliseu Imperial (Grande)",
        width: 1000,
        height: 700,
        obstacles: [
            { x: 220, y: 150, w: 60, h: 160 },
            { x: 720, y: 150, w: 60, h: 160 },
            { x: 220, y: 390, w: 60, h: 160 },
            { x: 720, y: 390, w: 60, h: 160 },
            { x: 420, y: 320, w: 160, h: 60 }
        ]
    },
    {
        name: "Corredores Táticos",
        width: 850,
        height: 600,
        obstacles: [
            { x: 180, y: 120, w: 180, h: 30 },
            { x: 490, y: 120, w: 180, h: 30 },
            { x: 180, y: 450, w: 180, h: 30 },
            { x: 490, y: 450, w: 180, h: 30 },
            { x: 395, y: 220, w: 60, h: 160 }
        ]
    }
];

const SWORDS = {
    "Espada Básica": { damage: 12, speedMult: 1.0, length: 46, cost: 0 },
    "Lâmina de Cobalto": { damage: 18, speedMult: 1.15, length: 52, cost: 400 },
    "Katana Solar": { damage: 25, speedMult: 1.35, length: 58, cost: 1200 },
    "Foice do Abismo": { damage: 38, speedMult: 1.25, length: 66, cost: 3500 }
};

let onlineSockets = {}; // socket.id -> email
let matchQueue = { '1v1': [], '2v2': [] };
let activeRooms = {}; // roomId -> { id, mode, map, players: {}, state: 'playing' }

// Verifica interseção de segmento de reta com retângulo (para bloquear espada na parede)
function lineIntersectsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
    function lineIntersectsLine(a1, b1, a2, b2, c1, d1, c2, d2) {
        let ccw = (p1x, p1y, p2x, p2y, p3x, p3y) => (p3y - p1y) * (p2x - p1x) > (p2y - p1y) * (p3x - p1x);
        return (ccw(a1, b1, c1, d1, c2, d2) !== ccw(a2, b2, c1, d1, c2, d2)) &&
               (ccw(a1, b1, a2, b2, c1, d1) !== ccw(a1, b1, a2, b2, c2, d2));
    }
    return lineIntersectsLine(x1, y1, x2, y2, rx, ry, rx + rw, ry) ||
           lineIntersectsLine(x1, y1, x2, y2, rx + rw, ry, rx + rw, ry + rh) ||
           lineIntersectsLine(x1, y1, x2, y2, rx + rw, ry + rh, rx, ry + rh) ||
           lineIntersectsLine(x1, y1, x2, y2, rx, ry + rh, rx, ry);
}

// Colisão suave círculo vs retângulo
function resolveCircleRect(p, obs) {
    let closestX = Math.max(obs.x, Math.min(p.x, obs.x + obs.w));
    let closestY = Math.max(obs.y, Math.min(p.y, obs.y + obs.h));
    let dx = p.x - closestX;
    let dy = p.y - closestY;
    let distSq = dx * dx + dy * dy;

    if (distSq < p.radius * p.radius) {
        let dist = Math.sqrt(distSq);
        if (dist === 0) {
            p.x += p.radius;
        } else {
            let overlap = p.radius - dist;
            p.x += (dx / dist) * overlap;
            p.y += (dy / dist) * overlap;
        }
    }
}

io.on('connection', (socket) => {
    // Autenticação (E-mail + Senha ou Google)
    socket.on('auth', (data) => {
        const email = (data.email || '').trim().toLowerCase();
        const password = (data.password || '').trim();
        const username = (data.username || '').trim();
        const isGoogle = !!data.isGoogle;

        if (!email || (!isGoogle && !password)) {
            return socket.emit('authError', 'Preencha e-mail e senha corretamente.');
        }

        // Conta já existe
        if (db.users[email]) {
            const user = db.users[email];
            if (!isGoogle && user.password !== password) {
                return socket.emit('authError', 'Senha incorreta para este e-mail.');
            }
            onlineSockets[socket.id] = email;
            return socket.emit('authSuccess', user);
        }

        // Nova conta: valida Username único
        if (!username || username.length < 3) {
            return socket.emit('authError', 'Escolha um username único com pelo menos 3 caracteres.');
        }
        const lowerUser = username.toLowerCase();
        if (db.usernames[lowerUser]) {
            return socket.emit('authError', `O username "${username}" já está em uso! Escolha outro.`);
        }

        const newUser = {
            email,
            password: isGoogle ? 'GOOGLE_OAUTH' : password,
            username,
            avatar: data.avatar || 'man.png',
            coins: 150,
            elo: 1000,
            wins: 0,
            losses: 0,
            speedLvl: 1,
            hpLvl: 1,
            equippedSword: "Espada Básica",
            unlockedSwords: ["Espada Básica"]
        };

        db.users[email] = newUser;
        db.usernames[lowerUser] = email;
        saveDB();

        onlineSockets[socket.id] = email;
        socket.emit('authSuccess', newUser);
    });

    // Atualizar Avatar
    socket.on('updateAvatar', (avatarData) => {
        const email = onlineSockets[socket.id];
        if (email && db.users[email]) {
            db.users[email].avatar = avatarData;
            saveDB();
            socket.emit('userUpdated', db.users[email]);
        }
    });

    // Loja: Comprar ou Equipar Espada
    socket.on('shopSword', (swordName) => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        const sword = SWORDS[swordName];
        if (!user || !sword) return;

        if (user.unlockedSwords.includes(swordName)) {
            user.equippedSword = swordName;
            saveDB();
            socket.emit('userUpdated', user);
        } else if (user.coins >= sword.cost) {
            user.coins -= sword.cost;
            user.unlockedSwords.push(swordName);
            user.equippedSword = swordName;
            saveDB();
            socket.emit('userUpdated', user);
        }
    });

    // Loja: Comprar Upgrades Permanentes
    socket.on('shopUpgrade', (type) => {
        const email = onlineSockets[socket.id];
        const user = db.users[email];
        if (!user) return;

        if (type === 'speed' && user.speedLvl < 10) {
            const cost = user.speedLvl * 200;
            if (user.coins >= cost) {
                user.coins -= cost;
                user.speedLvl++;
                saveDB();
                socket.emit('userUpdated', user);
            }
        } else if (type === 'hp' && user.hpLvl < 10) {
            const cost = user.hpLvl * 200;
            if (user.coins >= cost) {
                user.coins -= cost;
                user.hpLvl++;
                saveDB();
                socket.emit('userUpdated', user);
            }
        }
    });

    // Fila de Matchmaking (Somente jogadores reais, sem bots)
    socket.on('joinQueue', (mode) => {
        const email = onlineSockets[socket.id];
        if (!email || !db.users[email]) return;

        // Remove de qualquer fila anterior
        matchQueue['1v1'] = matchQueue['1v1'].filter(id => id !== socket.id);
        matchQueue['2v2'] = matchQueue['2v2'].filter(id => id !== socket.id);

        matchQueue[mode].push(socket.id);
        socket.emit('queueJoined', { mode, count: matchQueue[mode].length });
        tryCreateMatch(mode);
    });

    socket.on('leaveQueue', () => {
        matchQueue['1v1'] = matchQueue['1v1'].filter(id => id !== socket.id);
        matchQueue['2v2'] = matchQueue['2v2'].filter(id => id !== socket.id);
    });

    // Inputs de movimento do jogador na partida
    socket.on('playerInput', (data) => {
        const room = activeRooms[data.roomId];
        if (!room || !room.players[socket.id]) return;
        room.players[socket.id].keys = data.keys;
    });

    socket.on('disconnect', () => {
        matchQueue['1v1'] = matchQueue['1v1'].filter(id => id !== socket.id);
        matchQueue['2v2'] = matchQueue['2v2'].filter(id => id !== socket.id);

        // Se estava em uma partida, declara derrota por W.O.
        for (let roomId in activeRooms) {
            const room = activeRooms[roomId];
            if (room.players[socket.id] && room.state === 'playing') {
                room.players[socket.id].hp = 0;
            }
        }
        delete onlineSockets[socket.id];
    });
});

function tryCreateMatch(mode) {
    const needed = mode === '1v1' ? 2 : 4;
    if (matchQueue[mode].length < needed) return;

    // Ordena fila por Elo para pareamento justo
    matchQueue[mode].sort((a, b) => {
        const eloA = db.users[onlineSockets[a]]?.elo || 1000;
        const eloB = db.users[onlineSockets[b]]?.elo || 1000;
        return eloA - eloB;
    });

    const selected = matchQueue[mode].splice(0, needed);
    const roomId = 'room_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const selectedMap = MAPS[Math.floor(Math.random() * MAPS.length)];

    const room = {
        id: roomId,
        mode,
        map: selectedMap,
        players: {},
        state: 'playing'
    };

    selected.forEach((sockId, idx) => {
        const email = onlineSockets[sockId];
        const u = db.users[email];
        const team = (idx % 2 === 0) ? 1 : 2;
        const swordStats = SWORDS[u.equippedSword] || SWORDS["Espada Básica"];

        const spawnX = team === 1 ? 80 : selectedMap.width - 80;
        const spawnY = (selectedMap.height / (needed / 2 + 1)) * (Math.floor(idx / 2) + 1);

        const maxHp = 100 + (u.hpLvl - 1) * 20;
        const baseSpeed = 4.2 + (u.speedLvl - 1) * 0.35;

        room.players[sockId] = {
            socketId: sockId,
            email: u.email,
            username: u.username,
            avatar: u.avatar,
            elo: u.elo,
            team,
            x: spawnX,
            y: spawnY,
            radius: 28,
            hp: maxHp,
            maxHp: maxHp,
            speed: baseSpeed,
            swordName: u.equippedSword,
            swordDamage: swordStats.damage,
            swordSpeed: 0.09 * swordStats.speedMult,
            swordLength: swordStats.length,
            swordAngle: team === 1 ? 0 : Math.PI,
            hitCooldown: 0,
            keys: { up: false, down: false, left: false, right: false }
        };

        const sock = io.sockets.sockets.get(sockId);
        if (sock) sock.join(roomId);
    });

    activeRooms[roomId] = room;
    io.to(roomId).emit('matchStart', {
        roomId,
        mode,
        map: selectedMap,
        players: room.players
    });
}

// Loop de Física e Combate das Salas Ativas (60 FPS)
setInterval(() => {
    for (let roomId in activeRooms) {
        const room = activeRooms[roomId];
        if (room.state !== 'playing') continue;

        const pList = Object.values(room.players);

        // 1. Movimento e Rotação Contínua da Espada (Independente de andar!)
        for (let p of pList) {
            if (p.hp <= 0) continue;

            let vx = 0, vy = 0;
            if (p.keys.up) vy -= 1;
            if (p.keys.down) vy += 1;
            if (p.keys.left) vx -= 1;
            if (p.keys.right) vx += 1;

            if (vx !== 0 && vy !== 0) {
                vx *= Math.SQRT1_2;
                vy *= Math.SQRT1_2;
            }

            p.x += vx * p.speed;
            p.y += vy * p.speed;

            // Limites do mapa
            p.x = Math.max(p.radius, Math.min(room.map.width - p.radius, p.x));
            p.y = Math.max(p.radius, Math.min(room.map.height - p.radius, p.y));

            // Colisão suave com todas as paredes do mapa
            for (let obs of room.map.obstacles) {
                resolveCircleRect(p, obs);
            }

            // A espada gira SEMPRE, mesmo parado!
            p.swordAngle = (p.swordAngle + p.swordSpeed) % (Math.PI * 2);
            if (p.hitCooldown > 0) p.hitCooldown--;
        }

        // 2. Combate com Espadas Orbitais e Bloqueio por Parede
        for (let i = 0; i < pList.length; i++) {
            for (let j = 0; j < pList.length; j++) {
                if (i === j) continue;
                let attacker = pList[i];
                let target = pList[j];

                if (attacker.hp <= 0 || target.hp <= 0) continue;
                if (attacker.team === target.team) continue; // Sem fogo amigo no 2v2

                // Base e ponta da espada do atacante
                let baseDist = attacker.radius + 8;
                let tipDist = attacker.radius + attacker.swordLength;

                let baseX = attacker.x + Math.cos(attacker.swordAngle) * baseDist;
                let baseY = attacker.y + Math.sin(attacker.swordAngle) * baseDist;
                let tipX = attacker.x + Math.cos(attacker.swordAngle) * tipDist;
                let tipY = attacker.y + Math.sin(attacker.swordAngle) * tipDist;

                // Checa se a linha da lâmina toca o corpo do alvo
                let midX = (baseX + tipX) / 2;
                let midY = (baseY + tipY) / 2;

                let hitTip = Math.hypot(tipX - target.x, tipY - target.y) < target.radius;
                let hitMid = Math.hypot(midX - target.x, midY - target.y) < target.radius;

                if ((hitTip || hitMid) && attacker.hitCooldown <= 0) {
                    // Verifica se há parede bloqueando o golpe entre o atacante e o alvo
                    let blockedByWall = false;
                    for (let obs of room.map.obstacles) {
                        if (lineIntersectsRect(attacker.x, attacker.y, target.x, target.y, obs.x, obs.y, obs.w, obs.h)) {
                            blockedByWall = true;
                            break;
                        }
                    }

                    if (!blockedByWall) {
                        target.hp = Math.max(0, target.hp - attacker.swordDamage);
                        attacker.hitCooldown = 18; // Cooldown de 0.3s entre hits

                        // Empurrão (Knockback) ao acertar
                        let kbAngle = Math.atan2(target.y - attacker.y, target.x - attacker.x);
                        target.x += Math.cos(kbAngle) * 22;
                        target.y += Math.sin(kbAngle) * 22;
                        for (let obs of room.map.obstacles) resolveCircleRect(target, obs);
                    }
                }
            }
        }

        // 3. Verifica Vitória / Derrota da Partida
        const team1Alive = pList.some(p => p.team === 1 && p.hp > 0);
        const team2Alive = pList.some(p => p.team === 2 && p.hp > 0);

        if (!team1Alive || !team2Alive) {
            room.state = 'finished';
            const winningTeam = team1Alive ? 1 : 2;

            const winners = pList.filter(p => p.team === winningTeam);
            const losers = pList.filter(p => p.team !== winningTeam);

            const eloChange = 25;
            const coinReward = room.mode === '1v1' ? 120 : 180;

            winners.forEach(w => {
                const u = db.users[w.email];
                if (u) {
                    u.elo += eloChange;
                    u.coins += coinReward;
                    u.wins++;
                }
            });

            losers.forEach(l => {
                const u = db.users[l.email];
                if (u) {
                    u.elo = Math.max(100, u.elo - eloChange);
                    u.losses++;
                }
            });

            saveDB();

            // Envia resultado individualizado para cada jogador na sala
            pList.forEach(p => {
                const won = p.team === winningTeam;
                const opponentNames = (won ? losers : winners).map(o => o.username).join(', ');
                const updatedUser = db.users[p.email];

                io.to(p.socketId).emit('matchEnd', {
                    won,
                    opponentNames,
                    eloDelta: won ? +eloChange : -eloChange,
                    coinsEarned: won ? coinReward : 0,
                    user: updatedUser
                });
            });

            delete activeRooms[roomId];
        } else {
            io.to(roomId).emit('roomState', room.players);
        }
    }
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Verity Competitive Server rodando na porta ${PORT}`));
