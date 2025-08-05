const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const http = require('http');
const socketio = require('socket.io');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Load configuration
const config = require('./config.json');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Enhanced game state management
let rooms = new Map();
let playerSockets = new Map();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow inline scripts for simplicity
}));
app.use(compression());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  message: 'Too many requests from this IP'
});
app.use('/auth', limiter);

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'default_session_secret',
  resave: false,
  saveUninitialized: false
}));


// Passport configuration
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: config.clientID,
  clientSecret: config.clientSecret,
  callbackURL: config.callbackURL,
  scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
  return done(null, {
    id: profile.id,
    username: profile.username,
    discriminator: profile.discriminator,
    avatar: profile.avatar,
    email: profile.email
  });
}));

app.use(passport.initialize());
app.use(passport.session());

// Routes
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', 
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => {
    const { username, id, avatar, discriminator } = req.user;
    const avatarUrl = avatar ? 
      `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=64` :
      `https://cdn.discordapp.com/embed/avatars/${discriminator % 5}.png`;
    
    res.redirect(`/?user=${encodeURIComponent(username)}&avatar=${encodeURIComponent(avatarUrl)}&id=${id}`);
  }
);

app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

app.get('/api/rooms', (req, res) => {
  const publicRooms = Array.from(rooms.entries())
    .filter(([_, room]) => !room.private && room.players.length < config.maxPlayersPerRoom)
    .map(([id, room]) => ({
      id,
      playerCount: room.players.length,
      maxPlayers: config.maxPlayersPerRoom,
      created: room.created
    }));
  res.json(publicRooms);
});

app.use(express.static('public'));

// Enhanced Socket.IO handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  socket.on('joinRoom', ({ room, name, avatar, symbol, isPrivate = false }) => {
    try {
      // Validate input
      if (!room || !name || !symbol) {
        return socket.emit('error', 'Missing required fields');
      }
      
      if (name.length > 20 || room.length > 10) {
        return socket.emit('error', 'Name or room ID too long');
      }

      // Leave previous room if any
      const prevRoom = playerSockets.get(socket.id);
      if (prevRoom) {
        socket.leave(prevRoom);
        leaveRoom(socket.id, prevRoom);
      }

      // Initialize room if it doesn't exist
      if (!rooms.has(room)) {
        rooms.set(room, {
          id: room,
          players: [],
          gameState: {
            board: Array(9).fill(''),
            currentTurn: 'X',
            gameStatus: 'waiting',
            winner: null,
            moves: 0
          },
          created: Date.now(),
          private: isPrivate,
          timeout: null
        });
      }

      const roomData = rooms.get(room);
      
      // Check if room is full
      if (roomData.players.length >= config.maxPlayersPerRoom) {
        return socket.emit('roomFull', 'Room is full');
      }

      // Check if symbol is already taken
      const symbolTaken = roomData.players.some(p => p.symbol === symbol);
      if (symbolTaken) {
        return socket.emit('symbolTaken', 'Symbol already taken');
      }

      // Join room
      socket.join(room);
      playerSockets.set(socket.id, room);
      
      const player = {
        id: socket.id,
        name: name.trim(),
        avatar: avatar || 'https://cdn-icons-png.flaticon.com/512/149/149071.png',
        symbol,
        joinedAt: Date.now(),
        ready: false
      };

      roomData.players.push(player);
      
      // Emit room update to all players in room
      io.to(room).emit('roomUpdate', {
        players: roomData.players,
        gameState: roomData.gameState,
        roomId: room
      });

      // Start game if we have 2 players
      if (roomData.players.length === 2) {
        roomData.gameState.gameStatus = 'active';
        roomData.gameState.currentTurn = 'X';
        
        // Set game timeout
        roomData.timeout = setTimeout(() => {
          io.to(room).emit('gameTimeout', 'Game timed out due to inactivity');
          resetRoom(room);
        }, config.gameTimeout);
        
        io.to(room).emit('gameStart', {
          players: roomData.players,
          gameState: roomData.gameState
        });
      }

      socket.emit('joinSuccess', {
        roomId: room,
        player,
        inviteUrl: `${req.headers.origin || 'http://localhost:3000'}/game.html?room=${room}`
      });

    } catch (error) {
      console.error('Join room error:', error);
      socket.emit('error', 'Failed to join room');
    }
  });

  socket.on('makeMove', ({ room, index, symbol }) => {
    try {
      const roomData = rooms.get(room);
      if (!roomData) return socket.emit('error', 'Room not found');

      const player = roomData.players.find(p => p.id === socket.id);
      if (!player) return socket.emit('error', 'Player not in room');

      const { gameState } = roomData;
      
      // Validate move
      if (gameState.gameStatus !== 'active') {
        return socket.emit('error', 'Game is not active');
      }
      
      if (gameState.currentTurn !== symbol) {
        return socket.emit('error', 'Not your turn');
      }
      
      if (gameState.board[index] !== '') {
        return socket.emit('error', 'Cell already occupied');
      }

      // Make move
      gameState.board[index] = symbol;
      gameState.moves++;
      
      // Check for win
      const winner = checkWinner(gameState.board);
      if (winner) {
        gameState.gameStatus = 'finished';
        gameState.winner = winner;
        
        if (roomData.timeout) {
          clearTimeout(roomData.timeout);
          roomData.timeout = null;
        }
        
        io.to(room).emit('gameEnd', {
          winner: winner === 'tie' ? null : player.name,
          gameState,
          type: winner === 'tie' ? 'tie' : 'win'
        });
      } else {
        // Switch turns
        gameState.currentTurn = gameState.currentTurn === 'X' ? 'O' : 'X';
        
        io.to(room).emit('moveUpdate', {
          index,
          symbol,
          gameState,
          player: player.name
        });
      }

    } catch (error) {
      console.error('Make move error:', error);
      socket.emit('error', 'Failed to make move');
    }
  });

  socket.on('resetGame', ({ room }) => {
    try {
      const roomData = rooms.get(room);
      if (!roomData) return;

      const player = roomData.players.find(p => p.id === socket.id);
      if (!player) return;

      resetRoom(room);
      io.to(room).emit('gameReset', {
        gameState: roomData.gameState,
        resetBy: player.name
      });

    } catch (error) {
      console.error('Reset game error:', error);
    }
  });

  socket.on('playerReady', ({ room }) => {
    try {
      const roomData = rooms.get(room);
      if (!roomData) return;

      const player = roomData.players.find(p => p.id === socket.id);
      if (player) {
        player.ready = !player.ready;
        io.to(room).emit('playerReadyUpdate', {
          playerId: socket.id,
          ready: player.ready,
          players: roomData.players
        });
      }
    } catch (error) {
      console.error('Player ready error:', error);
    }
  });

  socket.on('chatMessage', ({ room, message }) => {
    try {
      const roomData = rooms.get(room);
      if (!roomData) return;

      const player = roomData.players.find(p => p.id === socket.id);
      if (!player) return;

      if (message.trim().length > 100) return;

      const chatMessage = {
        id: uuidv4(),
        player: player.name,
        avatar: player.avatar,
        message: message.trim(),
        timestamp: Date.now()
      };

      io.to(room).emit('chatMessage', chatMessage);
    } catch (error) {
      console.error('Chat message error:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    
    const room = playerSockets.get(socket.id);
    if (room) {
      leaveRoom(socket.id, room);
      playerSockets.delete(socket.id);
    }
  });
});

// Helper functions
function checkWinner(board) {
  const winPatterns = [
    [0,1,2], [3,4,5], [6,7,8], // rows
    [0,3,6], [1,4,7], [2,5,8], // columns
    [0,4,8], [2,4,6] // diagonals
  ];

  for (const pattern of winPatterns) {
    const [a, b, c] = pattern;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }

  return board.every(cell => cell !== '') ? 'tie' : null;
}

function resetRoom(roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData) return;

  if (roomData.timeout) {
    clearTimeout(roomData.timeout);
    roomData.timeout = null;
  }

  roomData.gameState = {
    board: Array(9).fill(''),
    currentTurn: 'X',
    gameStatus: roomData.players.length === 2 ? 'active' : 'waiting',
    winner: null,
    moves: 0
  };

  roomData.players.forEach(p => p.ready = false);
}

function leaveRoom(socketId, roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData) return;

  roomData.players = roomData.players.filter(p => p.id !== socketId);
  
  if (roomData.players.length === 0) {
    if (roomData.timeout) clearTimeout(roomData.timeout);
    rooms.delete(roomId);
  } else {
    // If game was active and a player left, end the game
    if (roomData.gameState.gameStatus === 'active') {
      roomData.gameState.gameStatus = 'finished';
      io.to(roomId).emit('playerLeft', {
        gameState: roomData.gameState,
        remainingPlayers: roomData.players
      });
    }
    
    io.to(roomId).emit('roomUpdate', {
      players: roomData.players,
      gameState: roomData.gameState,
      roomId
    });
  }
}

// Cleanup inactive rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  const inactiveThreshold = 30 * 60 * 1000; // 30 minutes
  
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.created > inactiveThreshold && room.players.length === 0) {
      if (room.timeout) clearTimeout(room.timeout);
      rooms.delete(roomId);
    }
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || config.port;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🎮 Game ready at http://localhost:${PORT}`);
});