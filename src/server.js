const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const RoomManager = require('./roomManager');
const Signaling = require('./signaling');

// 鈹€鈹€ Config 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const PORT = process.env.PORT || 3000;
const KEEPALIVE_INTERVAL = 25000; // 25 s 鈥?keeps Render free tier awake

// 鈹€鈹€ HTTP + Express 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const app = express();
app.use(express.static('public')); // optional static lobby page

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: roomManager.getRoomList().length });
});

// 鈹€鈹€ WebSocket server 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 鈹€鈹€ Core services 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const roomManager = new RoomManager();
const signaling = new Signaling(roomManager);

// 鈹€鈹€ Player 鈫?WebSocket mapping 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
/** @type {Map<string, WebSocket>} */
const playerSockets = new Map();

// 鈹€鈹€ Message router 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const { type, payload = {} } = msg;

  switch (type) {
    // 鈹€鈹€ Room management 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    case 'create_room': {
      const room = roomManager.createRoom(payload.name, payload.maxPlayers);
      ws.send(JSON.stringify({ type: 'room_created', payload: { roomId: room.id, name: room.name, maxPlayers: room.maxPlayers } }));
      break;
    }

    case 'join_room': {
      const { roomId, playerName } = payload;
      if (!roomId) return;

      const playerId = uuidv4();
      const room = roomManager.addPlayer(roomId, playerId, playerName || '鐜╁', ws);

      if (!room) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: '鎴块棿宸叉弧鎴栦笉瀛樺湪' } }));
        return;
      }

      playerSockets.set(playerId, ws);
      ws._playerId = playerId;
      ws._roomId = roomId;

      ws.send(JSON.stringify({
        type: 'room_joined',
        payload: {
          roomId,
          playerId,
          players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })),
          maxPlayers: room.maxPlayers,
        },
      }));

      // notify others
      signaling.broadcastToRoom(roomId, playerId, {
        type: 'player_joined',
        payload: { playerId, playerName: playerName || '鐜╁', players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) },
      });
      break;
    }

    case 'room_list': {
      ws.send(JSON.stringify({ type: 'room_list', payload: { rooms: roomManager.getRoomList() } }));
      break;
    }

    case 'set_ready': {
      const { roomId, ready } = payload;
      const playerId = ws._playerId;
      if (!roomId || !playerId) return;

      roomManager.setReady(roomId, playerId, ready);
      const room = roomManager.getRoom(roomId);
      if (room) {
        signaling.broadcastToAll(roomId, {
          type: 'ready_update',
          payload: { players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) },
        });
      }
      break;
    }

    case 'start_game': {
      const { roomId } = payload;
      const playerId = ws._playerId;
      if (!roomId || !playerId) return;

      const room = roomManager.getRoom(roomId);
      if (!room) return;
      if (!roomManager.allReady(roomId)) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: '鏈夌帺瀹跺皻鏈噯澶? } }));
        return;
      }

      room.state = 'char_select';
      signaling.broadcastToAll(roomId, {
        type: 'game_start',
        payload: {
          roomId,
          players: room.players.map(p => ({ id: p.id, name: p.name })),
          peerIds: room.players.map(p => p.id),
        },
      });
      break;
    }

    case 'all_ready_fight': {
      const { roomId } = payload;
      const room = roomManager.getRoom(roomId);
      if (room) {
        room.state = 'fighting';
        signaling.broadcastToAll(roomId, {
          type: 'fight_begin',
          payload: { roomId },
        });
      }
      break;
    }

    // 鈹€鈹€ WebRTC signaling relay 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    case 'webrtc_offer':
    case 'webrtc_answer':
    case 'webrtc_ice': {
      const { roomId, targetId } = payload;
      if (!roomId || !targetId) return;

      signaling.sendToPlayer(roomId, targetId, {
        type,
        payload: {
          fromId: ws._playerId,
          ...(payload.sdp ? { sdp: payload.sdp } : {}),
          ...(payload.candidate ? { candidate: payload.candidate } : {}),
        },
      });
      break;
    }

    // 鈹€鈹€ Character image sync 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    case 'char_image': {
      const { roomId, imageBase64, charName } = payload;
      const playerId = ws._playerId;
      if (!roomId || !playerId) return;

      signaling.broadcastToRoom(roomId, playerId, {
        type: 'char_image',
        payload: { playerId, imageBase64, charName },
      });
      break;
    }

    // 鈹€鈹€ Fight state checksum 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    case 'state_checksum': {
      const { roomId, frame, checksum } = payload;
      const playerId = ws._playerId;
      if (!roomId || !playerId) return;

      signaling.broadcastToRoom(roomId, playerId, {
        type: 'state_checksum',
        payload: { playerId, frame, checksum },
      });
      break;
    }

    // 鈹€鈹€ Return to lobby 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    case 'back_to_lobby': {
      const { roomId } = payload;
      if (!roomId) return;

      const room = roomManager.getRoom(roomId);
      if (room) {
        room.state = 'waiting';
        room.players.forEach(p => { p.ready = false; });
        signaling.broadcastToAll(roomId, {
          type: 'back_to_lobby',
          payload: { players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) },
        });
      }
      break;
    }

    default:
      // unknown type 鈥?silently ignore
      break;
  }
}

// 鈹€鈹€ Connection lifecycle 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    const playerId = ws._playerId;
    const roomId = ws._roomId;

    if (playerId) {
      playerSockets.delete(playerId);

      if (roomId) {
        const { room } = roomManager.removePlayer(playerId);

        if (room) {
          signaling.broadcastToAll(roomId, {
            type: 'player_left',
            payload: {
              playerId,
              players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })),
            },
          });
        }
      }
    }
  });
});

// 鈹€鈹€ Keep alive (ping all clients + Render free-tier anti-sleep) 鈹€鈹€
const keepAlive = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  roomManager.cleanup();
}, KEEPALIVE_INTERVAL);

wss.on('close', () => clearInterval(keepAlive));

// 鈹€鈹€ Self-ping for Render free tier 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
setInterval(() => {
  http.get(`http://localhost:${PORT}/health`, () => {});
}, 14 * 60 * 1000); // every 14 min 鈥?prevents Render idle shutdown

// 鈹€鈹€ Start 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
server.listen(PORT, () => {
  console.log(`馃 KOF Signaling Server running on port ${PORT}`);
});
