// KOF Signaling v1-simple — in-memory, no Deno KV dependency
const sockets = {};
const playerRooms = {};
const rooms = new Map();

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function send(pid, data) {
  const ws = sockets[pid];
  if (ws) try { ws.send(JSON.stringify(data)); } catch { delete sockets[pid]; }
}

function bcastRoom(room, excludeId, type, payload) {
  for (const p of room.players || []) {
    if (p.id === excludeId) continue;
    send(p.id, { type, payload });
  }
}

function bcastAll(room, type, payload) {
  for (const p of room.players || []) send(p.id, { type, payload });
}

function removePlayer(roomId, pid) {
  const room = rooms.get(roomId);
  if (!room) return;
  const idx = (room.players || []).findIndex(p => p.id === pid);
  if (idx === -1) return;
  room.players.splice(idx, 1);
  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else {
    bcastAll(room, "player_left", { playerId: pid, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) });
  }
}

function cleanup(pid) {
  if (playerRooms[pid]) removePlayer(playerRooms[pid], pid);
  delete sockets[pid];
  delete playerRooms[pid];
}

Deno.serve((req) => {
  const url = new URL(req.url);

  // HTTP room list fallback
  if (url.pathname === "/rooms" || url.pathname === "/health") {
    const list = [...rooms.values()].filter(r => r.state === "waiting").map(r => ({ id: r.id, name: r.name, players: (r.players||[]).length, maxPlayers: r.maxPlayers||2 }));
    return new Response(JSON.stringify(url.pathname==="/health"?{status:"ok",rooms:list.length}:{rooms:list}), {
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type, upgrade" },
    });
  }

  const upgrade = req.headers.get("upgrade");
  if (upgrade !== "websocket") {
    return new Response(JSON.stringify({ error: "use websocket" }), {
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  const { socket: client, response } = Deno.upgradeWebSocket(req);
  const playerId = "p_" + crypto.randomUUID().substring(0, 8);
  sockets[playerId] = client;

  client.onopen = () => {};
  client.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { type, payload = {} } = msg;

    if (type === "room_list") {
      const list = [...rooms.values()].filter(r => r.state === "waiting").map(r => ({ id: r.id, name: r.name, players: (r.players||[]).length, maxPlayers: r.maxPlayers||2 }));
      send(playerId, { type: "room_list", payload: { rooms: list } });
      return;
    }

    if (type === "create_room") {
      const id = genCode();
      rooms.set(id, { id, name: payload.name || "拳皇对战", maxPlayers: 2, players: [{ id: playerId, name: "房主", ready: false }], state: "waiting" });
      playerRooms[playerId] = id;
      const room = rooms.get(id);
      send(playerId, { type: "room_created", payload: { roomId: id, playerId, name: room.name, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) } });
      return;
    }

    if (type === "join_room") {
      const room = rooms.get(payload.roomId);
      if (!room) { send(playerId, { type: "error", payload: { message: "房间不存在" } }); return; }
      if (room.players.length >= room.maxPlayers) { send(playerId, { type: "error", payload: { message: "房间已满" } }); return; }
      if (room.state !== "waiting") { send(playerId, { type: "error", payload: { message: "游戏已开始" } }); return; }
      room.players.push({ id: playerId, name: payload.playerName || "挑战者", ready: false });
      playerRooms[playerId] = payload.roomId;
      send(playerId, { type: "room_joined", payload: { roomId: room.id, playerId, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })), maxPlayers: room.maxPlayers } });
      bcastRoom(room, playerId, "player_joined", { playerId, playerName: payload.playerName || "挑战者", players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) });
      return;
    }

    if (type === "set_ready") {
      const room = rooms.get(payload.roomId);
      if (!room) return;
      const p = room.players.find(p => p.id === playerId);
      if (!p) return;
      p.ready = !!payload.ready;
      bcastAll(room, "ready_update", { players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) });
      return;
    }

    if (type === "start_game") {
      const room = rooms.get(payload.roomId);
      if (!room) return;
      if (!room.players.every(p => p.ready)) { send(playerId, { type: "error", payload: { message: "有玩家尚未准备" } }); return; }
      room.state = "fighting";
      bcastAll(room, "game_start", { roomId: room.id, players: room.players.map(p => ({ id: p.id, name: p.name })), peerIds: room.players.map(p => p.id) });
      return;
    }

    if (type === "back_to_lobby") {
      const room = rooms.get(payload.roomId);
      if (room) { room.state = "waiting"; room.players.forEach(p => p.ready = false); bcastAll(room, "back_to_lobby", { players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) }); }
      return;
    }

    if (type === "leave_room") {
      if (playerRooms[playerId]) { removePlayer(playerRooms[playerId], playerId); delete playerRooms[playerId]; }
      return;
    }

    if (["webrtc_offer","webrtc_answer","webrtc_ice","char_image"].includes(type)) {
      const room = rooms.get(payload.roomId);
      if (!room) return;
      if (payload.targetId) {
        const extra = {}; if(payload.sdp) extra.sdp=payload.sdp; if(payload.candidate) extra.candidate=payload.candidate;
        send(payload.targetId, { type, payload: { fromId: playerId, ...extra } });
      } else {
        bcastRoom(room, playerId, type, payload);
      }
      return;
    }
  };

  client.onclose = () => cleanup(playerId);
  client.onerror = () => cleanup(playerId);

  return response;
});
