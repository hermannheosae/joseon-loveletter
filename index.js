const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const deckMaster = [
  "👮‍♂️포졸(1)", "👮‍♂️포졸(1)", "👮‍♂️포졸(1)", "👮‍♂️포졸(1)", "👮‍♂️포졸(1)",
  "🔮무당(2)", "🔮무당(2)", "⚔️검객(3)", "⚔️검객(3)", "🩺의녀(4)", 
  "🩺의녀(4)", "🤴세자(5)", "🤴세자(5)", "👑임금(6)", "🌸후궁(7)", "👸중전(8)"
];

const cardTotalCounts = { "1":5, "2":2, "3":2, "4":2, "5":2, "6":1, "7":1, "8":1 };
let rooms = {};

io.on('connection', (socket) => {
  socket.on('login', ({ name, roomName }) => {
    if (!roomName) roomName = "1"; 
    socket.join(roomName);
    socket.roomName = roomName;
    if (!rooms[roomName]) {
      rooms[roomName] = { players: {}, playerOrder: [], turnIndex: 0, isGameStarted: false, deck: [], discardedCards: [] };
    }
    const room = rooms[roomName];
    if (room.isGameStarted || room.playerOrder.length >= 4) return;
    room.players[socket.id] = { name: name, hand: [], isProtected: false, isEliminated: false };
    room.playerOrder.push(socket.id);
    io.to(roomName).emit('gameLog', `📢 [${name}] 님이 입장하셨습니다.`);
    broadcastRoomInfo(roomName);
  });

  socket.on('requestStart', () => {
    const room = rooms[socket.roomName];
    if (!room || room.playerOrder.length < 2) return;
    startGame(socket.roomName);
  });

  socket.on('playCard', (data) => {
    const room = rooms[socket.roomName];
    if (!room || !room.isGameStarted || room.playerOrder[room.turnIndex] !== socket.id) return;

    const attacker = room.players[socket.id];
    const cardName = data.card;
    const targetId = Object.keys(room.players).find(id => room.players[id].name === data.target);
    const targetPlayer = targetId ? room.players[targetId] : null;

    io.to(socket.roomName).emit('gameLog', `🃏 [${attacker.name}]님이 [${cardName}]을(를) 사용했습니다.`);

    const idx = attacker.hand.indexOf(cardName);
    if (idx > -1) attacker.hand.splice(idx, 1);
    room.discardedCards.push(cardName);
    socket.emit('updateHand', attacker.hand);

    if (targetPlayer && targetPlayer.isProtected && targetId !== socket.id) {
      io.to(socket.roomName).emit('gameLog', `🛡️ [${targetPlayer.name}]님은 치료 중이라 효과 무효!`);
    } else {
      if (cardName.includes("포졸") && targetPlayer) {
        if (targetPlayer.hand[0].includes(data.guess)) {
          io.to(socket.roomName).emit('gameLog', `🎉 체포 성공! [${targetPlayer.name}] 탈락!`);
          eliminatePlayer(socket.roomName, targetId);
        } else { io.to(socket.roomName).emit('gameLog', `💨 [${attacker.name}]의 체포 실패!`); }
      } else if (cardName.includes("무당") && targetPlayer) {
        socket.emit('privateNotice', `🔮 [${targetPlayer.name}]의 패는 [${targetPlayer.hand[0]}]입니다.`);
      } else if (cardName.includes("검객") && targetPlayer) {
        const myVal = parseInt(attacker.hand[0].match(/\d+/)[0]);
        const taVal = parseInt(targetPlayer.hand[0].match(/\d+/)[0]);
        if (myVal > taVal) { 
          io.to(socket.roomName).emit('gameLog', `⚔️ 대결 결과: [${targetPlayer.name}] 탈락!`);
          eliminatePlayer(socket.roomName, targetId); 
        } else if (myVal < taVal) { 
          io.to(socket.roomName).emit('gameLog', `⚔️ 대결 결과: [${attacker.name}] 탈락!`);
          eliminatePlayer(socket.roomName, socket.id); 
        } else { io.to(socket.roomName).emit('gameLog', `⚔️ 대결 결과: 무승부!`); }
      } else if (cardName.includes("의녀")) {
        attacker.isProtected = true;
        io.to(socket.roomName).emit('gameLog', `🩺 [${attacker.name}]님이 보호받습니다.`);
      } else if (cardName.includes("세자") && targetPlayer) {
        const disc = targetPlayer.hand.pop();
        room.discardedCards.push(disc);
        io.to(socket.roomName).emit('gameLog', `🤴 [${targetPlayer.name}]님이 [${disc}]를 버렸습니다.`);
        if (disc.includes("중전")) {
          eliminatePlayer(socket.roomName, targetId);
        } else {
          const next = drawCard(room);
          if (next) { targetPlayer.hand.push(next); io.to(targetId).emit('updateHand', targetPlayer.hand); }
        }
      } else if (cardName.includes("임금") && targetPlayer) {
        const myCard = attacker.hand.pop();
        const taCard = targetPlayer.hand.pop();
        attacker.hand.push(taCard); targetPlayer.hand.push(myCard);
        io.to(socket.id).emit('updateHand', attacker.hand);
        io.to(targetId).emit('updateHand', targetPlayer.hand);
        io.to(socket.roomName).emit('gameLog', `👑 패 교환 완료!`);
      } else if (cardName.includes("중전")) {
        io.to(socket.roomName).emit('gameLog', `👸 [${attacker.name}]님이 중전을 잃어 탈락했습니다!`);
        eliminatePlayer(socket.roomName, socket.id);
      }
    }

    sendCardStats(socket.roomName);
    if (!checkWinCondition(socket.roomName)) {
        if (room.deck.length === 0) determineWinnerByScore(socket.roomName);
        else nextTurn(socket.roomName);
    }
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomName];
    if (room) {
      delete room.players[socket.id];
      room.playerOrder = room.playerOrder.filter(id => id !== socket.id);
      if (room.playerOrder.length === 0) delete rooms[socket.roomName];
      else broadcastRoomInfo(socket.roomName);
    }
  });
});

function startGame(roomName) {
  const room = rooms[roomName];
  room.isGameStarted = true;
  room.deck = [...deckMaster].sort(() => Math.random() - 0.5);
  room.deck.pop();
  room.discardedCards = [];
  room.playerOrder = room.playerOrder.sort(() => Math.random() - 0.5);
  room.playerOrder.forEach(id => {
    room.players[id].hand = [drawCard(room)];
    room.players[id].isEliminated = false;
    room.players[id].isProtected = false;
    io.to(id).emit('updateHand', room.players[id].hand);
  });
  room.turnIndex = 0;
  io.to(roomName).emit('gameStartedNotice'); 
  sendCardStats(roomName); 
  nextTurn(roomName, true);
  broadcastRoomInfo(roomName);
}

function nextTurn(roomName, isFirst = false) {
  const room = rooms[roomName];
  if (!isFirst) {
    do { room.turnIndex = (room.turnIndex + 1) % room.playerOrder.length; } 
    while (room.players[room.playerOrder[room.turnIndex]].isEliminated);
  }
  const id = room.playerOrder[room.turnIndex];
  room.players[id].isProtected = false;
  const card = drawCard(room);
  if (card) {
    room.players[id].hand.push(card);
    io.to(id).emit('updateHand', room.players[id].hand);
    io.to(roomName).emit('turnUpdate', { turnName: room.players[id].name, turnId: id });
  }
}

function determineWinnerByScore(roomName) {
  const room = rooms[roomName];
  let survivors = room.playerOrder.filter(id => !room.players[id].isEliminated)
    .map(id => ({ 
        id, 
        name: room.players[id].name, 
        score: room.players[id].hand[0] ? parseInt(room.players[id].hand[0].match(/\d+/)[0]) : 0,
        card: room.players[id].hand[0] || "알수없음"
    }));
  survivors.sort((a, b) => b.score - a.score);
  
  io.to(roomName).emit('gameLog', `🎴 덱 소진! 최종 패를 공개합니다.`);
  survivors.forEach(p => { io.to(roomName).emit('gameLog', `📜 [${p.name}]: ${p.card}`); });
  
  const winner = survivors[0];
  const cardOnlyName = winner.card.replace(/\(\d+\)/, ""); 
  io.to(roomName).emit('gameLog', `✨ 마지막 생존자 [${winner.name}]님이 ${winner.score}번 [${cardOnlyName}]카드로 최종 승리하였습니다!`);
  endGame(roomName, winner.id);
}

function checkWinCondition(roomName) {
  const survivors = rooms[roomName].playerOrder.filter(id => !rooms[roomName].players[id].isEliminated);
  if (survivors.length === 1) {
    const winnerId = survivors[0];
    const winner = rooms[roomName].players[winnerId];
    const fullCardName = winner.hand[0] || "알수없음";
    const score = fullCardName.match(/\d+/) ? fullCardName.match(/\d+/)[0] : "?";
    const cardOnlyName = fullCardName.replace(/\(\d+\)/, "");
    io.to(roomName).emit('gameLog', `✨ 마지막 생존자 [${winner.name}]님이 ${score}번 [${cardOnlyName}]카드로 최종 승리하였습니다!`);
    endGame(roomName, winnerId);
    return true; 
  }
  return false;
}

function eliminatePlayer(roomName, id) {
  const room = rooms[roomName];
  room.players[id].isEliminated = true;
  if (room.players[id].hand.length > 0) room.discardedCards.push(room.players[id].hand[0]);
  room.players[id].hand = [];
  io.to(id).emit('updateHand', []);
  broadcastRoomInfo(roomName);
}

function endGame(roomName, id) {
  rooms[roomName].isGameStarted = false;
  const winnerName = rooms[roomName].players[id].name;
  io.to(roomName).emit('gameOver', { winnerName: winnerName });
  broadcastRoomInfo(roomName);
}

function drawCard(room) { return room.deck.pop(); }
function sendCardStats(roomName) {
  const room = rooms[roomName];
  let currentCounts = {};
  room.discardedCards.forEach(card => { 
    let val = card.match(/\d+/)[0]; 
    currentCounts[val] = (currentCounts[val] || 0) + 1; 
  });
  let stats = [];
  const cardNames = { "1":"포졸", "2":"무당", "3":"검객", "4":"의녀", "5":"세자", "6":"임금", "7":"후궁", "8":"중전" };
  const emojies = { "1":"👮‍♂️", "2":"🔮", "3":"⚔️", "4":"🩺", "5":"🤴", "6":"👑", "7":"🌸", "8":"👸" };
  for (let i = 1; i <= 8; i++) {
    let key = i.toString();
    let discarded = currentCounts[key] || 0;
    stats.push({ num: key, name: cardNames[key], emoji: emojies[key], discarded: discarded, total: cardTotalCounts[key] });
  }
  io.to(roomName).emit('updateCardStats', { stats, deckCount: room.deck.length });
}

function broadcastRoomInfo(roomName) {
  const room = rooms[roomName];
  const playerStates = room.playerOrder.map(id => ({ name: room.players[id].name, isEliminated: room.players[id].isEliminated }));
  io.to(roomName).emit('roomInfo', { count: room.playerOrder.length, playerStates, isStarted: room.isGameStarted });
}

server.listen(process.env.PORT || 10000);
