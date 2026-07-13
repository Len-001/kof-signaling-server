// KOF Signaling Server — Deno Deploy version
// WebSocket room management + WebRTC relay

const ROOM_CLEANUP_MS = 10 * 60 * 1000;

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const rooms = new Map();
const sockets = {};

Deno.serve((req) => {
  const url = new URL(req.url);

  // Health check
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", rooms: rooms.size }), {
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type, upgrade",
      },
    });
  }

  // WebSocket upgrade
  const upgrade = req.headers.get("upgrade");
  if (upgrade !== "websocket") {
    return new Response(JSON.stringify({ status: "use websocket" }), {
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  const { socket: client, response } = Deno.upgradeWebSocket(req);
  const playerId = "p_" + crypto.randomUUID().substring(0, 8);
  let currentRoomId = null;
  sockets[playerId] = client;

  client.onopen = () => console.log(`Connected: ${playerId}`);

  client.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const { type, payload = {} } = msg;

    switch (type) {
      case "room_list": {
        const list = [...rooms.values()]
          .filter(r => r.state === "waiting")
          .map(r => ({ id: r.id, name: r.name, players: r.players.length, maxPlayers: r.maxPlayers }));
        send({ type: "room_list", payload: { rooms: list } });
        break;
      }

      case "create_room": {
        const id = genCode();
        const room = {
          id, name: payload.name || "拳皇对战", maxPlayers: 2,
          players: [{ id: playerId, name: "房主", ready: false }],
          state: "waiting", createdAt: Date.now(),
        };
        rooms.set(id, room);
        currentRoomId = id;
        send({ type: "room_created", payload: { roomId: id, playerId, name: room.name, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) } });
        break;
      }

      case "join_room": {
        const room = rooms.get(payload.roomId);
        if (!room) { send({ type: "error", payload: { message: "房间不存在" } }); break; }
        if (room.players.length >= room.maxPlayers) { send({ type: "error", payload: { message: "房间已满" } }); break; }
        if (room.state !== "waiting") { send({ type: "error", payload: { message: "游戏已开始" } }); break; }
        room.players.push({ id: playerId, name: payload.playerName || "挑战者", ready: false });
        currentRoomId = payload.roomId;
        send({ type: "room_joined", payload: { roomId: room.id, playerId, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })), maxPlayers: room.maxPlayers } });
        broadcastToRoom(room, playerId, { type: "player_joined", payload: { playerId, playerName: payload.playerName || "挑战者", players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) } });
        break;
      }

      case "set_ready": {
        const room = rooms.get(payload.roomId);
        if (!room) break;
        const p = room.players.find(p => p.id === playerId);
        if (!p) break;
        p.ready = !!payload.ready;
        broadcastToAll(room, { type: "ready_update", payload: { players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) } });
        break;
      }

      case "start_game": {
        const room = rooms.get(payload.roomId);
        if (!room) break;
        if (!room.players.every(p => p.ready)) { send({ type: "error", payload: { message: "有玩家尚未准备" } }); break; }
        room.state = "char_select";
        broadcastToAll(room, { type: "game_start", payload: { roomId: room.id, players: room.players.map(p => ({ id: p.id, name: p.name })), peerIds: room.players.map(p => p.id) } });
        break;
      }

      case "all_ready_fight": {
        const room = rooms.get(payload.roomId);
        if (!room) break;
        room.state = "fighting";
        broadcastToAll(room, { type: "fight_begin", payload: { roomId: room.id } });
        break;
      }

      case "back_to_lobby": {
        const room = rooms.get(payload.roomId);
        if (room) { room.state = "waiting"; room.players.forEach(p => p.ready = false); broadcastToAll(room, { type: "back_to_lobby", payload: { players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) } }); }
        break;
      }

      case "leave_room": {
        if (currentRoomId) { removePlayer(currentRoomId, playerId); currentRoomId = null; }
        break;
      }

      case "webrtc_offer": case "webrtc_answer": case "webrtc_ice": {
        const room = rooms.get(payload.roomId);
        if (!room) break;
        const target = room.players.find(p => p.id === payload.targetId);
        if (target && sockets[target.id]) {
          try { sockets[target.id].send(JSON.stringify({ type, payload: { fromId: playerId, ...(payload.sdp ? { sdp: payload.sdp } : {}), ...(payload.candidate ? { candidate: payload.candidate } : {}) } })); } catch {}
        }
        break;
      }

      case "char_image": {
        const room = rooms.get(payload.roomId);
        if (room) broadcastToRoom(room, playerId, { type: "char_image", payload: { playerId, imageBase64: payload.imageBase64, charName: payload.charName } });
        break;
      }
    }
  };

  client.onclose = () => { if (currentRoomId) removePlayer(currentRoomId, playerId); delete sockets[playerId]; };
  client.onerror = () => { if (currentRoomId) removePlayer(currentRoomId, playerId); delete sockets[playerId]; };

  return response;

  function send(data) { try { client.send(JSON.stringify(data)); } catch {} }
  function broadcastToRoom(room, excludeId, data) { for (const p of room.players) { if (p.id === excludeId) continue; const ws = sockets[p.id]; if (ws) try { ws.send(JSON.stringify(data)); } catch { delete sockets[p.id]; } } }
  function broadcastToAll(room, data) { for (const p of room.players) { const ws = sockets[p.id]; if (ws) try { ws.send(JSON.stringify(data)); } catch { delete sockets[p.id]; } } }
  function removePlayer(roomId, pid) { const room = rooms.get(roomId); if (!room) return; const idx = room.players.findIndex(p => p.id === pid); if (idx === -1) return; room.players.splice(idx, 1); if (room.players.length === 0) setTimeout(() => rooms.delete(roomId), ROOM_CLEANUP_MS); else broadcastToAll(room, { type: "player_left", payload: { playerId: pid, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) } }); }
});
