// KOF Signaling Server v2.1 鈥?Deno KV + cross-instance message queue
// Fix: properly cleanup rooms when host leaves + async cleanup

const kv = await Deno.openKv();
const sockets = {};
const playerRooms = {};

setInterval(pollQueue, 300);

Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type, upgrade",
      },
    });
  }
  if (url.pathname === "/rooms") return handleHttpRooms();

  const upgrade = req.headers.get("upgrade");
  if (upgrade !== "websocket") {
    return new Response(JSON.stringify({ error: "use WebSocket" }), {
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  const { socket: client, response } = Deno.upgradeWebSocket(req);
  const playerId = "p_" + crypto.randomUUID().substring(0, 8);
  sockets[playerId] = client;

  client.onopen = () => console.log("+ " + playerId);
  client.onmessage = (ev) => handleMsg(playerId, ev.data);
  client.onclose = () => { cleanup(playerId).catch(() => {}); };
  client.onerror = () => { cleanup(playerId).catch(() => {}); };

  return response;
});

async function handleHttpRooms() {
  const rooms = [];
  for await (const e of kv.list({ prefix: ["rooms"] })) {
    if (e.value && e.value.state === "waiting") {
      rooms.push({
        id: e.value.id, name: e.value.name,
        players: (e.value.players || []).length,
        maxPlayers: e.value.maxPlayers || 2,
      });
    }
  }
  return new Response(JSON.stringify({ rooms }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

async function handleMsg(playerId, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { type, payload = {} } = msg;

  if (type === "room_list") {
    const rooms = [];
    for await (const e of kv.list({ prefix: ["rooms"] })) {
      if (e.value && e.value.state === "waiting") {
        rooms.push({ id: e.value.id, name: e.value.name, players: (e.value.players || []).length, maxPlayers: e.value.maxPlayers || 2 });
      }
    }
    send(playerId, { type: "room_list", payload: { rooms } });
    return;
  }

  if (type === "create_room") {
    const id = genCode();
    const room = { id, name: payload.name || "鎷崇殗瀵规垬", maxPlayers: 2, players: [{ id: playerId, name: "鎴夸富", ready: false }], state: "waiting", createdAt: Date.now() };
    await kv.set(["rooms", id], room);
    playerRooms[playerId] = id;
    send(playerId, { type: "room_created", payload: { roomId: id, playerId, name: room.name, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) } });
    return;
  }

  if (type === "join_room") {
    const entry = await kv.get(["rooms", payload.roomId]);
    const room = entry.value;
    if (!room) { send(playerId, { type: "error", payload: { message: "鎴块棿涓嶅瓨鍦? } }); return; }
    if ((room.players || []).length >= (room.maxPlayers || 2)) { send(playerId, { type: "error", payload: { message: "鎴块棿宸叉弧" } }); return; }
    if (room.state !== "waiting") { send(playerId, { type: "error", payload: { message: "娓告垙宸插紑濮? } }); return; }
    room.players.push({ id: playerId, name: payload.playerName || "鎸戞垬鑰?, ready: false });
    await kv.set(["rooms", payload.roomId], room);
    playerRooms[playerId] = payload.roomId;
    send(playerId, { type: "room_joined", payload: { roomId: room.id, playerId, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })), maxPlayers: room.maxPlayers } });
    await bcastRoom(room, playerId, "player_joined", { playerId, playerName: payload.playerName || "鎸戞垬鑰?, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) });
    return;
  }

  if (type === "set_ready") {
    const entry = await kv.get(["rooms", payload.roomId]);
    const room = entry.value;
    if (!room) return;
    const p = (room.players || []).find(p => p.id === playerId);
    if (!p) return;
    p.ready = !!payload.ready;
    await kv.set(["rooms", payload.roomId], room);
    await bcastAll(room, "ready_update", { players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) });
    return;
  }

  if (type === "start_game") {
    const entry = await kv.get(["rooms", payload.roomId]);
    const room = entry.value;
    if (!room) return;
    if (!(room.players || []).every(p => p.ready)) { send(playerId, { type: "error", payload: { message: "鏈夌帺瀹跺皻鏈噯澶? } }); return; }
    room.state = "fighting";
    await kv.set(["rooms", payload.roomId], room);
    await bcastAll(room, "game_start", { roomId: room.id, players: room.players.map(p => ({ id: p.id, name: p.name })), peerIds: room.players.map(p => p.id) });
    return;
  }

  if (type === "back_to_lobby") {
    const entry = await kv.get(["rooms", payload.roomId]);
    const room = entry.value;
    if (room) { room.state = "waiting"; (room.players || []).forEach(p => p.ready = false); await kv.set(["rooms", payload.roomId], room); await bcastAll(room, "back_to_lobby", { players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) }); }
    return;
  }

  if (type === "leave_room") {
    if (playerRooms[playerId]) { await removePlayer(playerRooms[playerId], playerId); delete playerRooms[playerId]; }
    return;
  }

  if (["webrtc_offer", "webrtc_answer", "webrtc_ice", "webrtc_ready", "char_image"].includes(type)) {
    const entry = await kv.get(["rooms", payload.roomId]);
    const room = entry.value;
    if (!room) return;
    if (payload.targetId) {
      const extra = {}; if (payload.sdp) extra.sdp = payload.sdp; if (payload.candidate) extra.candidate = payload.candidate; if (payload.imageBase64) extra.imageBase64 = payload.imageBase64; if (payload.charName) extra.charName = payload.charName;
      send(payload.targetId, { type, payload: { fromId: playerId, ...extra } });
    } else {
      await bcastRoom(room, playerId, type, payload);
    }
    return;
  }
}

function send(pid, data) { const ws = sockets[pid]; if (ws) try { ws.send(JSON.stringify(data)); } catch { delete sockets[pid]; } }

async function bcastRoom(room, excludeId, type, payload) {
  for (const p of (room.players || [])) {
    if (p.id === excludeId) continue;
    if (sockets[p.id]) { send(p.id, { type, payload }); }
    else { await kv.set(["msgs", p.id, Date.now() + "_" + crypto.randomUUID().substring(0, 6)], { type, payload }); }
  }
}

async function bcastAll(room, type, payload) {
  for (const p of (room.players || [])) {
    if (sockets[p.id]) { send(p.id, { type, payload }); }
    else { await kv.set(["msgs", p.id, Date.now() + "_" + crypto.randomUUID().substring(0, 6)], { type, payload }); }
  }
}

async function pollQueue() {
  const now = Date.now();
  const toDelete = [];
  for await (const entry of kv.list({ prefix: ["msgs"] })) {
    const key = entry.key;
    const ts = parseInt(String(key[2]).split("_")[0]);
    if (now - ts > 5000) { toDelete.push(key); continue; }
    if (sockets[key[1]]) { send(key[1], entry.value); toDelete.push(key); }
  }
  for (const key of toDelete) await kv.delete(key);
}

async function removePlayer(roomId, pid) {
  const entry = await kv.get(["rooms", roomId]);
  const room = entry.value;
  if (!room) return;
  const idx = (room.players || []).findIndex(p => p.id === pid);
  if (idx === -1) return;
  room.players.splice(idx, 1);
  if (room.players.length === 0) {
    await kv.delete(["rooms", roomId]);
    console.log("Room deleted: " + roomId);
  } else {
    await kv.set(["rooms", roomId], room);
    await bcastAll(room, "player_left", { playerId: pid, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })) });
  }
}

async function cleanup(pid) {
  if (playerRooms[pid]) {
    await removePlayer(playerRooms[pid], pid);
    delete playerRooms[pid];
  }
  delete sockets[pid];
}

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = ""; for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
