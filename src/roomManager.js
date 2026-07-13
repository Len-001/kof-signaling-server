const { v4: uuidv4 } = require('uuid');

const ROOM_CLEANUP_MS = 10 * 60 * 1000; // remove empty rooms after 10 min
const ROOM_CODE_LEN = 5;

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  /** Create a new room, returns the room object. */
  createRoom(name, maxPlayers) {
    const id = this._genCode();
    const room = {
      id,
      name: name || '鎴块棿 ' + id,
      maxPlayers: Math.min(Math.max(maxPlayers || 2, 2), 4),
      players: [],       // { id, name, ws, ready }
      state: 'waiting',  // waiting | char_select | fighting
      createdAt: Date.now(),
    };
    this.rooms.set(id, room);
    return room;
  }

  /** Remove a room by id. */
  removeRoom(id) {
    this.rooms.delete(id);
  }

  /** Get a room by id. */
  getRoom(id) {
    return this.rooms.get(id) || null;
  }

  /** Add a player to a room. Returns null on failure. */
  addPlayer(roomId, playerId, playerName, ws) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (room.players.length >= room.maxPlayers) return null;
    if (room.state !== 'waiting') return null;

    room.players.push({ id: playerId, name: playerName, ws, ready: false });
    return room;
  }

  /** Remove a player from their room. Returns the room and removed player, or nulls. */
  removePlayer(playerId) {
    for (const [, room] of this.rooms) {
      const idx = room.players.findIndex(p => p.id === playerId);
      if (idx !== -1) {
        const removed = room.players.splice(idx, 1)[0];
        if (room.players.length === 0) {
          this.rooms.delete(room.id);
        } else {
          // un-ready everyone when someone leaves
          room.players.forEach(p => { p.ready = false; });
        }
        return { room, removed };
      }
    }
    return { room: null, removed: null };
  }

  /** Find which room a player is in. */
  findPlayerRoom(playerId) {
    for (const [, room] of this.rooms) {
      if (room.players.some(p => p.id === playerId)) return room;
    }
    return null;
  }

  /** Set a player's ready status. */
  setReady(roomId, playerId, ready) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const p = room.players.find(p => p.id === playerId);
    if (!p) return false;
    p.ready = !!ready;
    return true;
  }

  /** Check if all players in a room are ready. */
  allReady(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.players.length < 2) return false;
    return room.players.every(p => p.ready);
  }

  /** Get public room list for lobby display. */
  getRoomList() {
    return [...this.rooms.values()]
      .filter(r => r.state === 'waiting')
      .map(r => ({
        id: r.id,
        name: r.name,
        players: r.players.length,
        maxPlayers: r.maxPlayers,
      }));
  }

  /** Periodic cleanup of empty stale rooms. */
  cleanup() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (room.players.length === 0 && now - room.createdAt > ROOM_CLEANUP_MS) {
        this.rooms.delete(id);
      }
    }
  }

  /** Generate a short readable room code. */
  _genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return this.rooms.has(code) ? this._genCode() : code;
  }
}

module.exports = RoomManager;
