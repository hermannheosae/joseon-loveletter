const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const deckMaster = [
  "👮‍♂️포졸(1)", "👮‍♂️포졸(1)", "👮‍♂️포졸(1)", "👮‍♂️포졸(1)", "👮‍♂️포졸(1)",
  "🎭광대(2)", "🎭광대(2)",       
  "⚔️검객(3)", "⚔️검객(3)",       
  "💊의녀(4)", "💊의녀(4)",       
  "🗡️자객(5)", "🗡️자객(5)",       
  "👑임금(6)",                    
  "🌺후궁(7)",                    
  "👸왕비(8)"                     
];

const cardTotalCounts = { "1":5, "2":2, "3":2, "4":2, "5":2, "6":1, "7":1, "8":1 };
let rooms = {};

io.on('connection', (socket) => {
  socket.on('login', ({ name, roomName }) => {
    if (!roomName) roomName = "1"; 
    socket.join(roomName);
    socket.roomName = roomName;

    if (!rooms[roomName]) {
      rooms[roomName] = {
        players: {},
        playerOrder: [],
        turnIndex: 0,
        isGameStarted: false,
        deck: [],
        discardedCards: []
      };
    }

    const room = rooms[roomName];
    if (room.isGameStarted || room.playerOrder.length >= 4) return;

    room.players[socket.id] = { 
      name: name, 
      hand: [],
      isProtected: false,
      isEliminated: false
    };
    room.playerOrder.push(socket.id);

    io.to(roomName).emit('gameLog', `📢 [${name}] 님이 입장하셨습니다.`);
    broadcastRoomInfo(roomName);
    sendCardStats(roomName);
  });

  socket.on('requestStart', () => {
    const roomName = socket.roomName;
    const room = rooms[roomName];
    if (!room || room.playerOrder.length < 2 || room.isGameStarted) return;
    startGame(roomName);
  });

  socket.on('playCard', (data) => {
    const roomName = socket.roomName;
    const room = rooms[roomName];
    if (!room || !room.isGameStarted) return;
    if (room.playerOrder[room.turnIndex] !== socket.id) return;

    const attacker = room.players[socket.id];
    const cardName = data.card;
    const targetName = data.target;
    const guess = data.guess;

    if (cardName.includes("자객") || cardName.includes("임금")) {
      if (attacker.hand.some(c => c.includes("후궁"))) {
        socket.emit('privateNotice', '✋ 후궁(7)이 손에 있을 때는 이 카드를 낼 수 없습니다! 후궁을 먼저 버리십시오.');
        return;
      }
    }

    room.discardedCards.push(cardName);
    const targetId = Object.keys(room.players).find(id => room.players[id].name === targetName);
    const targetPlayer = targetId ? room.players[targetId] : null;

    if (targetPlayer && targetPlayer.isProtected && targetId !== socket.id) {
       io.to(roomName).emit('gameLog', `🛡️ [${targetName}]님은 의녀의 치료 중이라 안전합니다.`);
    } else if (cardName.includes("포졸") && targetPlayer) {
      if (targetPlayer.hand.some(c => c.includes(guess))) {
        io.to(roomName).emit('gameLog', `🎉 체포 성공! [${targetName}]님 탈락!`);
        eliminatePlayer(roomName, targetId);
      } else {
        io.to(roomName).emit('gameLog', `💨 체포 실패!`);
      }
    } else if (cardName.includes("광대") && targetPlayer) {
      socket.emit('privateNotice', `🎭 [${targetName}]의 패: ${targetPlayer.hand}`);
    } else if (cardName.includes("검객") && targetPlayer) {
      const myCard = attacker.hand.find(c => c !== cardName) || attacker.hand[0];
      const myVal = getCardValue(myCard);
      const targetVal = getCardValue(targetPlayer.hand[0]);
      if (myVal > targetVal) eliminatePlayer(roomName, targetId);
      else if (myVal < targetVal) eliminatePlayer(roomName, socket.id);
      else io.to(roomName).emit('gameLog', `🤝 무승부!`);
    } else if (cardName.includes("의녀")) {
      attacker.isProtected = true;
    } else if (cardName.includes("자객") && targetPlayer) {
      const discarded = targetPlayer.hand.pop();
      room.discardedCards.push(discarded);
      if (discarded && discarded.includes("왕비")) eliminatePlayer(roomName, targetId);
      else {
        const newCard = drawCard(room);
        if (newCard) targetPlayer.hand.push(newCard);
        io.to(targetId).emit('updateHand', targetPlayer.hand);
      }
    } else if (cardName.includes("임금") && targetPlayer) {
      const myCard = attacker.hand.find(c => c !== cardName);
      const targetCard = targetPlayer.hand[0];
      attacker.hand = [cardName, targetCard];
      targetPlayer.hand = [myCard];
      socket.emit('updateHand', [targetCard]);
      io.to(targetId).emit('updateHand', [myCard]);
    } else if (cardName.includes("왕비")) {
      eliminatePlayer(roomName, socket.id);
    }

    if (!room.players[socket.id].isEliminated) {
      const idx = attacker.hand.indexOf(cardName);
      if (idx > -1) attacker.hand.splice(idx, 1);
      socket.emit('updateHand', attacker.hand);
    }

    sendCardStats(roomName);
    if (checkWinCondition(roomName)) return;
    nextTurn(roomName);
  });

  socket.on('disconnect', () => {
    const roomName = socket.roomName;
    if (roomName && rooms[roomName]) {
      delete rooms[roomName].players[socket.id];
      rooms[roomName].playerOrder = rooms[roomName].playerOrder.filter(id => id !== socket.id);
      if (rooms[roomName].playerOrder.length === 0) delete rooms[roomName];
      else broadcastRoomInfo(roomName);
    }
  });
});

function broadcastRoomInfo(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  const playerStates = room.playerOrder.map(id => ({
    name: room.players[id].name,
    isEliminated: room.players[id].isEliminated
  }));
  io.to(roomName).emit('roomInfo', { roomName, count: room.playerOrder.length, playerStates, isStarted: room.isGameStarted });
}

function startGame(roomName) {
  const room = rooms[roomName];
  room.isGameStarted = true;
  room.deck = [...deckMaster].sort(() => Math.random() - 0.5);
  room.discardedCards = [];
  room.playerOrder.forEach(id => {
    room.players[id].hand = [drawCard(room)];
    room.players[id].isEliminated = false;
    room.players[id].isProtected = false;
    io.to(id).emit('updateHand', room.players[id].hand);
  });
  room.turnIndex = 0;
  nextTurn(roomName, true);
  broadcastRoomInfo(roomName);
}

function nextTurn(roomName, isFirst = false) {
  const room = rooms[roomName];
  if(!isFirst) {
    do { room.turnIndex = (room.turnIndex + 1) % room.playerOrder.length; } 
    while (room.players[room.playerOrder[room.turnIndex]].isEliminated);
  }
  const id = room.playerOrder[room.turnIndex];
  const p = room.players[id];
  p.isProtected = false;
  const card = drawCard(room);
  if (card) {
    p.hand.push(card);
    io.to(id).emit('updateHand', p.hand);
    io.to(roomName).emit('turnUpdate', { turnName: p.name, turnId: id });
  } else { determineWinnerByScore(roomName); }
}

function eliminatePlayer(roomName, id) {
  rooms[roomName].players[id].isEliminated = true;
  rooms[roomName].players[id].hand = [];
  io.to(id).emit('updateHand', []);
  io.to(id).emit('privateNotice', "💀 당신은 제거되었습니다.");
  broadcastRoomInfo(roomName);
}

function checkWinCondition(roomName) {
  const survivors = rooms[roomName].playerOrder.filter(id => !rooms[roomName].players[id].isEliminated);
  if (survivors.length === 1) { endGame(roomName, survivors[0]); return true; }
  return false;
}

function endGame(roomName, id) {
  io.to(roomName).emit('gameLog', `👑 최종 승리: [${rooms[roomName].players[id].name}] 👑`);
  rooms[roomName].isGameStarted = false;
  broadcastRoomInfo(roomName);
}

function drawCard(room) { return room.deck.pop(); }
function getCardValue(name) { return parseInt(name.replace(/[^0-9]/g, "")); }

function sendCardStats(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  let currentCounts = {};
  room.discardedCards.forEach(card => {
    let val = getCardValue(card);
    if (!currentCounts[val]) currentCounts[val] = 0;
    currentCounts[val]++;
  });
  let stats = [];
  const cardNames = { "1":"포졸", "2":"광대", "3":"검객", "4":"의녀", "5":"자객", "6":"임금", "7":"후궁", "8":"왕비" };
  for (let i = 1; i <= 8; i++) {
    let key = i.toString();
    stats.push({ num: key, name: cardNames[key], remaining: (cardTotalCounts[key] - (currentCounts[key] || 0)), total: cardTotalCounts[key] });
  }
  io.to(roomName).emit('updateCardStats', stats);
}

const port = process.env.PORT || 10000;
server.listen(port, () => { console.log("서버 가동 포트:", port); });
