/**
 * WebRTC signaling relay 鈥?forwards SDP offers, answers, and ICE candidates
 * between players in the same room.
 */
class Signaling {
  /**
   * @param {import('./roomManager')} roomManager
   */
  constructor(roomManager) {
    this.roomManager = roomManager;
  }

  /**
   * Send a signaling message to a specific player in a room.
   * @param {string} roomId
   * @param {string} targetPlayerId
   * @param {object} payload  鈥?the full forwarded message
   */
  sendToPlayer(roomId, targetPlayerId, payload) {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return false;

    const player = room.players.find(p => p.id === targetPlayerId);
    if (!player || player.ws.readyState !== 1) return false;

    player.ws.send(JSON.stringify(payload));
    return true;
  }

  /**
   * Broadcast a message to all players in a room EXCEPT the sender.
   * @param {string} roomId
   * @param {string} senderPlayerId
   * @param {object} payload
   */
  broadcastToRoom(roomId, senderPlayerId, payload) {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;

    for (const player of room.players) {
      if (player.id === senderPlayerId) continue;
      if (player.ws.readyState === 1) {
        player.ws.send(JSON.stringify(payload));
      }
    }
  }

  /**
   * Broadcast a message to ALL players in a room (including sender).
   */
  broadcastToAll(roomId, payload) {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;

    for (const player of room.players) {
      if (player.ws.readyState === 1) {
        player.ws.send(JSON.stringify(payload));
      }
    }
  }
}

module.exports = Signaling;
