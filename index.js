const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// 카드 구성 및 설명 (서버 관리용)
const deckMaster = [
  "👮‍♂️포졸(1)", "👮‍♂️포졸(1)", "👮‍♂️포졸(1)", "👮‍♂️포졸(1)", "👮‍♂️포졸(1)",
  "🎭광대(2)", "🎭광대(2)", "⚔️검객(3)", "⚔️검객(3)", "💊의녀(4)", 
  "💊의녀(4)", "🗡️자객(5)", "🗡️자객(5)", "👑임금(6)", "🌺후궁(7)", "👸왕비(8)"
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

    const attackerId = socket.id;
    const attacker = room.players[attackerId];
    const cardName = data.card;
    const targetName = data.target;
    const guess = data.guess;

    const cardIdx = attacker.hand.indexOf(cardName);
    if (cardIdx > -1) attacker.hand.splice(cardIdx, 1);
    room.discardedCards.push(cardName);

    const targetId = Object.keys(room.players).find(id => room.players[id].name === targetName);
    const targetPlayer = targetId ? room.players[targetId] : null;

    if (targetPlayer && targetPlayer.isProtected && targetId !== attackerId) {
      io.to(roomName).emit('gameLog', `🛡️ [${targetName}]님은 의녀의 치료 중이라 효과 무효!`);
    } 
    else if (cardName.includes("포졸") && targetPlayer) {
      if (targetPlayer.hand[0].includes(guess)) {
        io.to(roomName).emit('gameLog', `🎉 체포 성공! [${targetName}]의 패는 [${guess}]였습니다!`);
        eliminatePlayer(roomName, targetId);
      } else {
        io.to(roomName).emit('gameLog', `💨 [${attacker.name}]의 체포 실패!`);
      }
    } 
    else if (cardName.includes("광대") && targetPlayer) {
      socket.emit('privateNotice', `🎭 [${targetName}]의 패는 [${targetPlayer.hand[0]}]입니다.`);
    } 
    else if (cardName.includes("검객") && targetPlayer) {
      const myVal = getCardValue(attacker.hand[0]);
      const targetVal = getCardValue(targetPlayer.hand[0]);
      if (myVal > targetVal) {
        io.to(roomName).emit('gameLog', `⚔️ 대결 승리! [${targetName}] 탈락!`);
        eliminatePlayer(roomName, targetId);
      } else if (myVal < targetVal) {
        io.to(roomName).emit('gameLog', `⚔️ 대결 패배! [${attacker.name}] 탈락!`);
        eliminatePlayer(roomName, attackerId);
      } else {
        io.to(roomName).emit('gameLog', `⚔️ 비겼습니다!`);
      }
    } 
    else if (cardName.includes("의녀")) {
      attacker.isProtected = true;
    } 
    else if (cardName.includes("자객") && targetPlayer) {
      const discarded = targetPlayer.hand.pop();
      room.discardedCards.push(discarded);
      io.to(roomName).emit('gameLog', `🗡️ [${targetName}]님이 패 [${discarded}]를 버렸습니다.`);
      if (discarded.includes("왕비")) {
        eliminatePlayer(roomName, targetId);
      } else {
        const nextCard = drawCard(room);
        if (nextCard) {
          targetPlayer.hand.push(nextCard);
          io.to(targetId).emit('updateHand', targetPlayer.hand);
        }
      }
    } 
    else if (cardName.includes("임금") && targetPlayer) {
      const myRemainingCard = attacker.hand.pop();
      const targetCard = targetPlayer.hand.pop();
      attacker.hand.push(targetCard);
      targetPlayer.hand.push(myRemainingCard);
      io.to(attackerId).emit('updateHand', attacker.hand);
      io.to(targetId).emit('updateHand', targetPlayer.hand);
      io.to(roomName).emit('gameLog', `👑 [${attacker.name}]와 [${targetName}]의 패가 바뀌었습니다.`);
    } 
    else if (cardName.includes("왕비")) {
      eliminatePlayer(roomName, attackerId);
    }

    socket.emit('updateHand', attacker.hand);
    sendCardStats(roomName);
    
    if (!checkWinCondition(roomName)) {
      nextTurn(roomName);
    }
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

function startGame(roomName) {
  const room = rooms[roomName];
  room.isGameStarted = true;
  room.deck = [...deckMaster].sort(() => Math.random() - 0.5);
  room.deck.pop(); 
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
  if (!isFirst) {
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
  } else {
    determineWinnerByScore(roomName);
  }
}

function determineWinnerByScore(roomName) {
  const room = rooms[roomName];
  let survivors = room.playerOrder
    .filter(id => !room.players[id].isEliminated)
    .map(id => ({ id, name: room.players[id].name, score: getCardValue(room.players[id].hand[0]) }));
  survivors.sort((a, b) => b.score - a.score);
  io.to(roomName).emit('gameLog', `🎴 덱 소진! [${survivors[0].name}]님 최종 승리!`);
  endGame(roomName, survivors[0].id);
}

function checkWinCondition(roomName) {
  const survivors = rooms[roomName].playerOrder.filter(id => !rooms[roomName].players[id].isEliminated);
  if (survivors.length === 1) {
    endGame(roomName, survivors[0]);
    return true;
  }
  return false;
}

function eliminatePlayer(roomName, id) {
  const room = rooms[roomName];
  room.players[id].isEliminated = true;
  if(room.players[id].hand.length > 0) room.discardedCards.push(room.players[id].hand[0]);
  room.players[id].hand = [];
  io.to(id).emit('updateHand', []);
  io.to(roomName).emit('gameLog', `💀 [${room.players[id].name}] 탈락!`);
  broadcastRoomInfo(roomName);
}

function endGame(roomName, id) {
  rooms[roomName].isGameStarted = false;
  io.to(roomName).emit('gameLog', `🏆 승리: [${rooms[roomName].players[id].name}]`);
  broadcastRoomInfo(roomName);
}

function drawCard(room) { return room.deck.pop(); }
function getCardValue(name) { return parseInt(name.replace(/[^0-9]/g, "")) || 0; }

function sendCardStats(roomName) {
  const room = rooms[roomName];
  let currentCounts = {};
  room.discardedCards.forEach(card => {
    let val = getCardValue(card);
    currentCounts[val] = (currentCounts[val] || 0) + 1;
  });
  let stats = [];
  const cardNames = { "1":"포졸", "2":"광대", "3":"검객", "4":"의녀", "5":"자객", "6":"임금", "7":"후궁", "8":"왕비" };
  for (let i = 1; i <= 8; i++) {
    let key = i.toString();
    stats.push({ num: key, name: cardNames[key], remaining: (cardTotalCounts[key] - (currentCounts[key] || 0)), total: cardTotalCounts[key] });
  }
  io.to(roomName).emit('updateCardStats', stats);
}

function broadcastRoomInfo(roomName) {
  const room = rooms[roomName];
  if(!room) return;
  const playerStates = room.playerOrder.map(id => ({
    name: room.players[id].name,
    isEliminated: room.players[id].isEliminated
  }));
  io.to(roomName).emit('roomInfo', { roomName, count: room.playerOrder.length, playerStates, isStarted: room.isGameStarted });
}

const port = process.env.PORT || 10000;
server.listen(port, () => { console.log("서버 실행 중..."); });
