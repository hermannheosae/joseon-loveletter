const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// 1. 한국판 테마 카드 뭉치
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
      console.log(`🏠 방 생성: ${roomName}`);
    }

    const room = rooms[roomName];

    if (room.isGameStarted) {
      io.to(socket.id).emit('privateNotice', '이미 게임이 진행 중입니다.');
      return;
    }
    if (room.playerOrder.length >= 4) {
      io.to(socket.id).emit('privateNotice', '방이 꽉 찼습니다 (최대 4인).');
      return;
    }

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
    if (!roomName || !rooms[roomName]) return;
    const room = rooms[roomName];

    if (room.playerOrder.length < 2) {
      io.to(socket.id).emit('privateNotice', '최소 2명이 필요합니다.');
      return;
    }
    if (room.isGameStarted) return;
    
    startGame(roomName);
  });

  socket.on('playCard', (data) => {
    const roomName = socket.roomName;
    if (!roomName || !rooms[roomName]) return;
    const room = rooms[roomName];

    if (!room.isGameStarted) return;
    if (room.playerOrder[room.turnIndex] !== socket.id) return;

    const attacker = room.players[socket.id];
    const cardName = data.card;
    const targetName = data.target;
    const guess = data.guess;

    if (cardName.includes("자객") || cardName.includes("임금")) {
      const hasConcubine = attacker.hand.some(c => c.includes("후궁"));
      if (hasConcubine) {
        io.to(socket.id).emit('privateNotice', '✋ 후궁(7)이 손에 있을 때는 이 카드를 낼 수 없습니다! 후궁을 먼저 버리십시오.');
        return; 
      }
    }

    io.to(roomName).emit('gameLog', `--------------------------------`);
    io.to(roomName).emit('gameLog', `📜 [${attacker.name}] -> [${targetName || "없음"}] : [${cardName}]`);

    room.discardedCards.push(cardName);

    const targetId = Object.keys(room.players).find(id => room.players[id].name === targetName);
    const targetPlayer = targetId ? room.players[targetId] : null;

    if (targetPlayer && targetPlayer.isProtected && targetId !== socket.id) {
       io.to(roomName).emit('gameLog', `🛡️ [${targetName}]님은 '의녀'의 치료를 받고 있어 안전합니다! (무효)`);
    } 
    else if (cardName.includes("포졸")) { 
      if (targetPlayer) {
        const isCorrect = targetPlayer.hand.some(c => c.includes(guess));
        if (isCorrect) {
          io.to(roomName).emit('gameLog', `🎉 체포 성공! [${targetName}]님 탈락! (카드: ${targetPlayer.hand})`);
          targetPlayer.hand.forEach(c => room.discardedCards.push(c));
          eliminatePlayer(roomName, targetId);
        } else {
          io.to(roomName).emit('gameLog', `💨 헛다리 짚었습니다! (체포 실패)`);
        }
      }
    }
    else if (cardName.includes("광대")) { 
      if (targetPlayer) {
        io.to(socket.id).emit('privateNotice', `🎭 [${targetName}]의 패: ${targetPlayer.hand}`);
        io.to(roomName).emit('gameLog', `👁️ [${attacker.name}]님이 광대를 시켜 상대를 엿보았습니다.`);
      }
    }
    else if (cardName.includes("검객")) {
      if (targetPlayer) {
        const myLeftCard = attacker.hand.find(c => c !== cardName) || attacker.hand[0];
        const targetCard = targetPlayer.hand[0];
        
        const myVal = getCardValue(myLeftCard);
        const targetVal = getCardValue(targetCard);

        io.to(roomName).emit('gameLog', `⚔️ 진검승부! 나[${myVal}] vs 상대[${targetVal}]`);
        if (myVal > targetVal) {
            io.to(roomName).emit('gameLog', `💀 [${targetName}] 베임(탈락)!`);
            targetPlayer.hand.forEach(c => room.discardedCards.push(c));
            eliminatePlayer(roomName, targetId);
        } else if (myVal < targetVal) {
            io.to(roomName).emit('gameLog', `💀 [${attacker.name}] 역관광(탈락)!`);
            room.discardedCards.push(myLeftCard);
            eliminatePlayer(roomName, socket.id);
        } else {
            io.to(roomName).emit('gameLog', `🤝 무승부! 칼을 거둡니다.`);
        }
      }
    }
    else if (cardName.includes("의녀")) {
      attacker.isProtected = true;
      io.to(roomName).emit('gameLog', `💊 [${attacker.name}]님이 의녀의 보호를 받습니다.`);
    }
    else if (cardName.includes("자객")) {
      if (targetPlayer) {
        const discarded = targetPlayer.hand.pop(); 
        io.to(roomName).emit('gameLog', `🗡️ 자객의 습격! [${targetName}]님이 [${discarded}] 카드를 버렸습니다.`);
        if(discarded) room.discardedCards.push(discarded);

        if (discarded && discarded.includes("왕비")) {
          io.to(roomName).emit('gameLog', `💀 왕비가 암살당했습니다! [${targetName}]님 패배!`);
          eliminatePlayer(roomName, targetId);
        } else {
          const newCard = drawCard(room);
          if(newCard) {
            targetPlayer.hand.push(newCard);
            io.to(targetId).emit('updateHand', targetPlayer.hand);
            io.to(roomName).emit('gameLog', `🆕 놀란 마음을 추스르고 새 카드를 뽑습니다.`);
          }
        }
      }
    }
    else if (cardName.includes("임금")) {
      if (targetPlayer) {
        const myLeftCard = attacker.hand.find(c => c !== cardName) || attacker.hand[0];
        const targetCard = targetPlayer.hand[0];

        io.to(socket.id).emit('updateHand', [targetCard, "교환됨"]);
        io.to(targetId).emit('updateHand', [myLeftCard]); 

        attacker.hand = [cardName, targetCard]; 
        targetPlayer.hand = [myLeftCard];
        io.to(roomName).emit('gameLog', `👑 [${attacker.name}]님이 어명으로 [${targetName}]님과 패를 바꿨습니다.`);
      }
    }
    else if (cardName.includes("후궁")) {
      io.to(roomName).emit('gameLog', `🌺 후궁이 물러납니다. (효과 없음)`);
    }
    else if (cardName.includes("왕비")) {
      io.to(roomName).emit('gameLog', `💀 왕비가 궁을 떠났으므로 [${attacker.name}]님 처형(탈락)!`);
      eliminatePlayer(roomName, socket.id);
    }

    if (!room.players[socket.id].isEliminated) {
        const cardIdx = attacker.hand.indexOf(cardName);
        if (cardIdx > -1) attacker.hand.splice(cardIdx, 1);
        socket.emit('updateHand', attacker.hand);
    }

    sendCardStats(roomName);

    if (checkWinCondition(roomName)) return; 
    nextTurn(roomName);
  });

  socket.on('disconnect', () => {
    const roomName = socket.roomName;
    if (roomName && rooms[roomName]) {
      const room = rooms[roomName];
      if (room.players[socket.id]) {
        io.to(roomName).emit('gameLog', `🚪 [${room.players[socket.id].name}] 퇴장.`);
        delete room.players[socket.id];
        room.playerOrder = room.playerOrder.filter(id => id !== socket.id);
        
        if (room.playerOrder.length === 0) {
          delete rooms[roomName];
        } else {
          if (room.isGameStarted) checkWinCondition(roomName);
          else broadcastRoomInfo(roomName);
        }
      }
    }
  });
});

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
    let total = cardTotalCounts[key];
    let used = currentCounts[key] || 0;
    let remaining = total - used;
    if (remaining < 0) remaining = 0;
    stats.push({ num: key, name: cardNames[key], remaining: remaining, total: total });
  }
  io.to(roomName).emit('updateCardStats', stats);
}

function broadcastRoomInfo(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  
  const names = room.playerOrder.map(id => {
      const p = room.players[id];
      return p ? p.name : "Unknown";
  });

  io.to(roomName).emit('roomInfo', {
    roomName: roomName,
    count: room.playerOrder.length,
    names: names,
    isStarted: room.isGameStarted
  });
}

function startGame(roomName) {
  const room = rooms[roomName];
  if (!room) return;

  room.isGameStarted = true;
  room.deck = [...deckMaster]; 
  room.deck.sort(() => Math.random() - 0.5);
  room.discardedCards = [];

  io.to(roomName).emit('gameLog', `🏁 [${roomName}] 번 방 게임 시작!`);
  
  room.playerOrder.forEach(id => {
    room.players[id].hand = [];
    room.players[id].isEliminated = false;
    room.players[id].isProtected = false;
  });

  room.playerOrder.forEach(id => {
    const card = drawCard(room);
    if(card) room.players[id].hand.push(card);
    io.to(id).emit('updateHand', room.players[id].hand);
  });

  if (room.deck.length > 0) room.deck.pop(); 

  room.turnIndex = Math.floor(Math.random() * room.playerOrder.length);
  room.turnIndex = room.turnIndex - 1; 
  nextTurn(roomName);
  
  broadcastRoomInfo(roomName); 
  sendCardStats(roomName);
}

function nextTurn(roomName) {
  const room = rooms[roomName];
  if (!room) return;

  let aliveCount = room.playerOrder.filter(id => !room.players[id].isEliminated).length;
  if (aliveCount <= 1) return;

  do {
    room.turnIndex = (room.turnIndex + 1) % room.playerOrder.length;
  } while (room.players[room.playerOrder[room.turnIndex]].isEliminated);

  const currentSocketId = room.playerOrder[room.turnIndex];
  const currentPlayer = room.players[currentSocketId];

  currentPlayer.isProtected = false;

  io.to(roomName).emit('gameLog', `👉 [${currentPlayer.name}] 님의 차례!`);
  
  const newCard = drawCard(room);
  if (newCard) {
    currentPlayer.hand.push(newCard);
    io.to(currentSocketId).emit('updateHand', currentPlayer.hand);
  } else {
    io.to(roomName).emit('gameLog', `🃏 덱 소진! 숫자로 승부를 봅니다.`);
    determineWinnerByScore(roomName);
    return;
  }
  
  io.to(roomName).emit('turnUpdate', { turnName: currentPlayer.name, turnId: currentSocketId });
}

function eliminatePlayer(roomName, targetId) {
    const room = rooms[roomName];
    if (!room) return;
    const p = room.players[targetId];
    p.isEliminated = true;
    p.hand = [];
    io.to(targetId).emit('updateHand', []); 
    io.to(targetId).emit('privateNotice', "💀 당신은 제거되었습니다.");
    io.to(targetId).emit('gameLog', "💀 관전 모드 전환");
}

function checkWinCondition(roomName) {
    const room = rooms[roomName];
    if (!room) return false;
    const survivors = room.playerOrder.filter(id => !room.players[id].isEliminated);
    
    if (survivors.length === 1) {
        endGame(roomName, survivors[0]);
        return true; 
    }
    return false; 
}

function determineWinnerByScore(roomName) {
  const room = rooms[roomName];
  let maxScore = -1;
  let winners = [];

  room.playerOrder.forEach(id => {
    if (!room.players[id].isEliminated && room.players[id].hand.length > 0) {
      let score = getCardValue(room.players[id].hand[0]);
      if (score > maxScore) {
        maxScore = score;
        winners = [id];
      } else if (score === maxScore) {
        winners.push(id);
      }
    }
  });

  if (winners.length > 0) endGame(roomName, winners[0]); 
}

function endGame(roomName, winnerId) {
  const room = rooms[roomName];
  const winnerName = room.players[winnerId].name;
  io.to(roomName).emit('gameLog', `👑 최종 승리: [${winnerName}] !! 👑`);
  io.to(winnerId).emit('privateNotice', "축하합니다! 승리하셨습니다! 🎉");
  room.isGameStarted = false; 
  broadcastRoomInfo(roomName); 
}

function drawCard(room) {
    if (room.deck.length === 0) return null;
    return room.deck.pop();
}

function getCardValue(name) {
  return parseInt(name.replace(/[^0-9]/g, ""));
}

// [핵심 변경] 포트 자동 할당
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`한국판 러브레터 서버 가동 완료 (포트: ${port})`);
});
