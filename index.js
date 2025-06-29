const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.IO
const io = socketIo(server, {
  cors: {
    origin: ["https://exquisite-gelato-aa6d68.netlify.app/"],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());

// Store active users and rooms
const activeUsers = new Map();
const waitingUsers = new Set();
const activeRooms = new Map();
const blockedUsers = new Map(); // userId -> Set of blocked user IDs

// Utility functions
const generateRoomId = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

const findMatch = (userId) => {
  // Remove user from waiting list first
  waitingUsers.delete(userId);
  
  // Find another waiting user (not blocked)
  const userBlockList = blockedUsers.get(userId) || new Set();
  
  for (const waitingUserId of waitingUsers) {
    const waitingUserBlockList = blockedUsers.get(waitingUserId) || new Set();
    
    // Check if users haven't blocked each other
    if (!userBlockList.has(waitingUserId) && !waitingUserBlockList.has(userId)) {
      waitingUsers.delete(waitingUserId);
      return waitingUserId;
    }
  }
  
  return null;
};

const cleanupRoom = (roomId) => {
  const room = activeRooms.get(roomId);
  if (room) {
    // Notify both users that chat ended
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

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Send current user count
  io.emit('userCount', activeUsers.size + 1);

  socket.on('findMatch', ({ avatar, nickname }) => {
    console.log('User looking for match:', socket.id);
    
    // Store user info
    activeUsers.set(socket.id, {
      socket,
      avatar,
      nickname,
      roomId: null
    });
    
    // Update user count
    io.emit('userCount', activeUsers.size);
    
    // Try to find a match
    const partnerId = findMatch(socket.id);
    
    if (partnerId) {
      // Create room for matched users
      const roomId = generateRoomId();
      const partner = activeUsers.get(partnerId);
      
      if (partner) {
        // Update user room info
        activeUsers.get(socket.id).roomId = roomId;
        partner.roomId = roomId;
        
        // Store room info
        activeRooms.set(roomId, {
          users: [socket.id, partnerId],
          createdAt: new Date()
        });
        
        // Notify both users
        socket.emit('matchFound', { roomId, partnerId });
        partner.socket.emit('matchFound', { roomId, partnerId: socket.id });
        
        console.log('Match found:', socket.id, 'with', partnerId, 'in room', roomId);
      }
    } else {
      // Add to waiting list
      waitingUsers.add(socket.id);
      console.log('User added to waiting list:', socket.id);
      
      // Set timeout for search
      setTimeout(() => {
        if (waitingUsers.has(socket.id)) {
          waitingUsers.delete(socket.id);
          socket.emit('searchTimeout');
        }
      }, 30000); // 30 seconds timeout
    }
  });

  socket.on('cancelSearch', () => {
    waitingUsers.delete(socket.id);
    console.log('User cancelled search:', socket.id);
  });

  socket.on('joinRoom', (roomId) => {
    socket.join(roomId);
    
    const room = activeRooms.get(roomId);
    if (room) {
      const partnerId = room.users.find(id => id !== socket.id);
      const partner = activeUsers.get(partnerId);
      const currentUser = activeUsers.get(socket.id);
      
      if (partner && currentUser) {
        // Send partner info to current user
        socket.emit('partnerInfo', {
          id: partnerId,
          avatar: partner.avatar,
          nickname: partner.nickname
        });
        
        // Send current user info to partner
        partner.socket.emit('partnerInfo', {
          id: socket.id,
          avatar: currentUser.avatar,
          nickname: currentUser.nickname
        });
      }
    }
    
    console.log('User joined room:', socket.id, roomId);
  });

  socket.on('sendMessage', ({ roomId, message }) => {
    const room = activeRooms.get(roomId);
    if (room && room.users.includes(socket.id)) {
      // Send message to partner only
      socket.to(roomId).emit('newMessage', {
        id: Date.now(),
        content: message,
        sender: 'partner',
        timestamp: new Date()
      });
      
      console.log('Message sent in room:', roomId);
    }
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('partnerTyping', isTyping);
  });

  socket.on('leaveRoom', (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit('partnerDisconnected');
    
    const user = activeUsers.get(socket.id);
    if (user) {
      user.roomId = null;
    }
    
    console.log('User left room:', socket.id, roomId);
  });

  socket.on('reportUser', ({ roomId, reason, reportedUserId }) => {
    console.log('User reported:', reportedUserId, 'by:', socket.id, 'reason:', reason);
    
    // In a real app, you'd store this in a database
    // For now, we'll just log it and potentially disconnect the reported user
    
    // Clean up the room
    cleanupRoom(roomId);
  });

  socket.on('blockUser', ({ roomId, blockedUserId }) => {
    console.log('User blocked:', blockedUserId, 'by:', socket.id);
    
    // Add to block list
    if (!blockedUsers.has(socket.id)) {
      blockedUsers.set(socket.id, new Set());
    }
    blockedUsers.get(socket.id).add(blockedUserId);
    
    // Clean up the room
    cleanupRoom(roomId);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Remove from waiting list
    waitingUsers.delete(socket.id);
    
    // Get user info before removing
    const user = activeUsers.get(socket.id);
    if (user && user.roomId) {
      // Notify partner about disconnection
      socket.to(user.roomId).emit('partnerDisconnected');
      
      // Clean up room
      const room = activeRooms.get(user.roomId);
      if (room) {
        room.users = room.users.filter(id => id !== socket.id);
        if (room.users.length === 0) {
          activeRooms.delete(user.roomId);
        }
      }
    }
    
    // Remove user
    activeUsers.delete(socket.id);
    
    // Update user count
    io.emit('userCount', activeUsers.size);
  });
});

// Clean up old rooms periodically
setInterval(() => {
  const now = new Date();
  for (const [roomId, room] of activeRooms.entries()) {
    // Remove rooms older than 1 hour
    if (now - room.createdAt > 60 * 60 * 1000) {
      cleanupRoom(roomId);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});