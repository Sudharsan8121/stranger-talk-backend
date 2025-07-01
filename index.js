const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ✅ Full Dev Access: Allow All Origins (development only!)
const io = socketIo(server, {
  cors: {
    origin: "https://exquisite-gelato-aa6d68.netlify.app",
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());

// ✅ Add this route so backend doesn't return 404 at root
app.get('/', (req, res) => {
  res.send('🟢 Stranger Talk Backend Running');
});
// 💬 Active data stores
const activeUsers = new Map();
const waitingUsers = new Set();
const activeRooms = new Map();
const blockedUsers = new Map(); // userId → Set of blocked userIds

// 📦 Utility Functions
const generateRoomId = () =>
  Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

const findMatch = (userId) => {
  waitingUsers.delete(userId);
  const userBlockList = blockedUsers.get(userId) || new Set();

  for (const waitingUserId of waitingUsers) {
    const partnerBlockList = blockedUsers.get(waitingUserId) || new Set();

    if (!userBlockList.has(waitingUserId) && !partnerBlockList.has(userId)) {
      waitingUsers.delete(waitingUserId);
      return waitingUserId;
    }
  }
  return null;
};

const cleanupRoom = (roomId) => {
  const room = activeRooms.get(roomId);
  if (room) {
    room.users.forEach(userId => {
      const user = activeUsers.get(userId);
      if (user) {
        user.socket.emit('chatEnded', 'Chat session ended');
        user.roomId = null;
      }
    });
    activeRooms.delete(roomId);
  }
};

// 🔌 Socket Events
io.on('connection', (socket) => {
  console.log('🟢 User connected:', socket.id);
  io.emit('userCount', activeUsers.size + 1);

  socket.on('findMatch', ({ avatar, nickname }) => {
    console.log('🔎 Matching request from:', socket.id);

    activeUsers.set(socket.id, { socket, avatar, nickname, roomId: null });
    io.emit('userCount', activeUsers.size);

    const partnerId = findMatch(socket.id);
    if (partnerId) {
      const roomId = generateRoomId();
      const partner = activeUsers.get(partnerId);

      if (partner) {
        activeUsers.get(socket.id).roomId = roomId;
        partner.roomId = roomId;

        activeRooms.set(roomId, {
          users: [socket.id, partnerId],
          createdAt: new Date()
        });

        socket.emit('matchFound', { roomId, partnerId });
        partner.socket.emit('matchFound', { roomId, partnerId: socket.id });

        console.log(`✅ Match: ${socket.id} ↔ ${partnerId} in Room: ${roomId}`);
      }
    } else {
      waitingUsers.add(socket.id);
      console.log('⏳ User added to waiting list:', socket.id);

      setTimeout(() => {
        if (waitingUsers.has(socket.id)) {
          waitingUsers.delete(socket.id);
          socket.emit('searchTimeout');
        }
      }, 30000);
    }
  });

  socket.on('cancelSearch', () => {
    waitingUsers.delete(socket.id);
    console.log('❌ Search cancelled:', socket.id);
  });

  socket.on('joinRoom', (roomId) => {
    socket.join(roomId);
    const room = activeRooms.get(roomId);
    if (room) {
      const partnerId = room.users.find(id => id !== socket.id);
      const partner = activeUsers.get(partnerId);
      const currentUser = activeUsers.get(socket.id);

      if (partner && currentUser) {
        socket.emit('partnerInfo', {
          id: partnerId,
          avatar: partner.avatar,
          nickname: partner.nickname
        });
        partner.socket.emit('partnerInfo', {
          id: socket.id,
          avatar: currentUser.avatar,
          nickname: currentUser.nickname
        });
      }
    }
    console.log('🏠 User joined room:', socket.id, roomId);
  });

  socket.on('sendMessage', ({ roomId, message }) => {
    const room = activeRooms.get(roomId);
    if (room && room.users.includes(socket.id)) {
      socket.to(roomId).emit('newMessage', {
        id: Date.now(),
        content: message,
        sender: 'partner',
        timestamp: new Date()
      });
      console.log('📨 Message sent in room:', roomId);
    }
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('partnerTyping', isTyping);
  });

  socket.on('leaveRoom', (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit('partnerDisconnected');

    const user = activeUsers.get(socket.id);
    if (user) user.roomId = null;

    console.log('🚪 User left room:', socket.id, roomId);
  });

  socket.on('reportUser', ({ roomId, reason, reportedUserId }) => {
    console.log('⚠️ Report:', reportedUserId, 'by', socket.id, 'Reason:', reason);
    cleanupRoom(roomId);
  });

  socket.on('blockUser', ({ roomId, blockedUserId }) => {
    console.log('🚫 Block:', blockedUserId, 'by', socket.id);
    if (!blockedUsers.has(socket.id)) blockedUsers.set(socket.id, new Set());
    blockedUsers.get(socket.id).add(blockedUserId);
    cleanupRoom(roomId);
  });

  socket.on('disconnect', () => {
    console.log('🔴 User disconnected:', socket.id);
    waitingUsers.delete(socket.id);

    const user = activeUsers.get(socket.id);
    if (user && user.roomId) {
      socket.to(user.roomId).emit('partnerDisconnected');

      const room = activeRooms.get(user.roomId);
      if (room) {
        room.users = room.users.filter(id => id !== socket.id);
        if (room.users.length === 0) activeRooms.delete(user.roomId);
      }
    }

    activeUsers.delete(socket.id);
    io.emit('userCount', activeUsers.size);
  });
});

// 🧹 Clean up old rooms every 5 minutes
setInterval(() => {
  const now = new Date();
  for (const [roomId, room] of activeRooms.entries()) {
    if (now - room.createdAt > 60 * 60 * 1000) {
      cleanupRoom(roomId);
    }
  }
}, 5 * 60 * 1000);

// 🚀 Start Server (Full Network Access)
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
