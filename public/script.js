class XOGame {
  constructor() {
    this.socket = io();
    this.gameState = null;
    this.currentPlayer = null;
    this.roomId = null;
    this.players = [];
    this.chatVisible = true;
    
    this.initializeGame();
    this.setupEventListeners();
    this.setupSocketListeners();
  }

  initializeGame() {
    const params = new URLSearchParams(window.location.search);
    this.roomId = params.get("room");
    const isPrivate = params.get("private") === "true";
    
    if (!this.roomId) {
      alert("No room specified");
      window.location.href = "/";
      return;
    }

    const name = localStorage.getItem("name") || "Guest";
    const avatar = localStorage.getItem("avatar") || "https://cdn-icons-png.flaticon.com/512/149/149071.png";
    const symbol = localStorage.getItem("symbol") || "X";

    this.currentPlayer = { name, avatar, symbol };
    
    // Join the room
    this.socket.emit("joinRoom", {
      room: this.roomId,
      name,
      avatar,
      symbol,
      isPrivate
    });

    this.updateInviteUrl();
  }

  setupEventListeners() {
    // Reset button
    document.getElementById("reset-btn").addEventListener("click", () => {
      this.resetGame();
    });

    // Chat input
    const messageInput = document.getElementById("message-input");
    messageInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.sendMessage();
      }
    });

    // Board clicks will be handled dynamically when cells are created
  }

  setupSocketListeners() {
    this.socket.on("connect", () => {
      console.log("Connected to server");
    });

    this.socket.on("disconnect", () => {
      this.updateStatus("Disconnected from server", "error");
    });

    this.socket.on("joinSuccess", (data) => {
      console.log("Joined room successfully", data);
      this.updateStatus("Joined room successfully", "success");
    });

    this.socket.on("roomUpdate", (data) => {
      this.players = data.players;
      this.gameState = data.gameState;
      this.updatePlayersDisplay();
      this.updateGameBoard();
      this.updateGameStatus();
    });

    this.socket.on("gameStart", (data) => {
      this.players = data.players;
      this.gameState = data.gameState;
      this.updateStatus("Game started! Good luck! 🎮", "active");
      this.updatePlayersDisplay();
      this.updateGameBoard();
      this.enableResetButton();
      this.playSound("move");
    });

    this.socket.on("moveUpdate", (data) => {
      this.gameState = data.gameState;
      this.updateGameBoard();
      this.updateGameStatus();
      this.updatePlayersDisplay();
      this.playSound("move");
      
      // Show move notification
      this.showNotification(`${data.player} played ${data.symbol}`, "info");
    });

    this.socket.on("gameEnd", (data) => {
      this.gameState = data.gameState;
      this.updateGameBoard();
      
      if (data.type === "tie") {
        this.updateStatus("It's a tie! 🤝", "finished");
        this.showGameEndOverlay("It's a Tie!", "Good game! Want to play again?");
      } else {
        const isWinner = data.winner === this.currentPlayer.name;
        if (isWinner) {
          this.updateStatus(`You won! 🎉`, "finished");
          this.showGameEndOverlay("You Won! 🎉", "Congratulations! Play again?");
          this.playSound("win");
        } else {
          this.updateStatus(`${data.winner} won! 😔`, "finished");
          this.showGameEndOverlay(`${data.winner} Won!`, "Better luck next time!");
          this.playSound("lose");
        }
      }
      
      this.highlightWinningCells();
    });

    this.socket.on("gameReset", (data) => {
      this.gameState = data.gameState;
      this.updateGameBoard();
      this.updateGameStatus();
      this.updatePlayersDisplay();
      this.hideGameEndOverlay();
      this.showNotification(`Game reset by ${data.resetBy}`, "info");
    });

    this.socket.on("playerLeft", (data) => {
      this.players = data.remainingPlayers;
      this.gameState = data.gameState;
      this.updatePlayersDisplay();
      this.updateStatus("Opponent left the game", "waiting");
      this.showNotification("Your opponent left the game", "warning");
    });

    this.socket.on("chatMessage", (message) => {
      this.addChatMessage(message);
    });

    this.socket.on("roomFull", () => {
      alert("Room is full!");
      window.location.href = "/";
    });

    this.socket.on("symbolTaken", () => {
      alert("Symbol already taken! Please choose a different one.");
      window.location.href = "/";
    });

    this.socket.on("error", (message) => {
      console.error("Game error:", message);
      this.showNotification(message, "error");
    });
  }

  updateStatus(message, type = "info") {
    const statusElement = document.getElementById("game-status");
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
  }

  updatePlayersDisplay() {
    const playersGrid = document.getElementById("players-grid");
    
    if (this.players.length === 0) {
      playersGrid.innerHTML = '<div class="player-card"><p>Waiting for players...</p></div>';
      return;
    }

    playersGrid.innerHTML = this.players.map(player => {
      const isCurrentTurn = this.gameState && 
        this.gameState.gameStatus === "active" && 
        this.gameState.currentTurn === player.symbol;
      
      const isCurrentPlayer = player.name === this.currentPlayer.name;
      
      return `
        <div class="player-card ${isCurrentPlayer ? 'active' : ''} ${isCurrentTurn ? 'current-turn' : ''}">
          <img src="${player.avatar}" alt="${player.name}" class="player-avatar">
          <div class="player-name">${player.name} ${isCurrentPlayer ? '(You)' : ''}</div>
          <div class="player-symbol">${player.symbol === 'X' ? '❌' : '⭕'}</div>
          <div class="player-status">
            ${isCurrentTurn ? '🎯 Your Turn' : (this.gameState?.gameStatus === 'active' ? '⏳ Waiting' : '🎮 Ready')}
          </div>
        </div>
      `;
    }).join('');

    // Fill empty slots
    while (this.players.length < 2) {
      playersGrid.innerHTML += `
        <div class="player-card">
          <div class="player-name">Waiting for player...</div>
          <div class="player-status">🔍 Looking for opponent</div>
        </div>
      `;
      break; // Only show one waiting card
    }
  }

  updateGameBoard() {
    const board = document.getElementById("board");
    
    if (!this.gameState) {
      board.innerHTML = "";
      return;
    }

    board.innerHTML = "";
    
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.index = i;
      
      const cellValue = this.gameState.board[i];
      if (cellValue) {
        cell.textContent = cellValue === 'X' ? '❌' : '⭕';
        cell.classList.add("occupied");
      } else if (this.canMakeMove()) {
        cell.addEventListener("click", () => this.makeMove(i));
      }
      
      board.appendChild(cell);
    }
  }

  canMakeMove() {
    if (!this.gameState || this.gameState.gameStatus !== "active") return false;
    if (this.gameState.currentTurn !== this.currentPlayer.symbol) return false;
    return true;
  }

  makeMove(index) {
    if (!this.canMakeMove()) return;
    if (this.gameState.board[index] !== "") return;

    this.socket.emit("makeMove", {
      room: this.roomId,
      index,
      symbol: this.currentPlayer.symbol
    });
  }

  updateGameStatus() {
    if (!this.gameState) {
      this.updateStatus("Connecting...", "waiting");
      return;
    }

    switch (this.gameState.gameStatus) {
      case "waiting":
        this.updateStatus("Waiting for opponent...", "waiting");
        break;
      case "active":
        const isMyTurn = this.gameState.currentTurn === this.currentPlayer.symbol;
        if (isMyTurn) {
          this.updateStatus("Your turn! Make your move 🎯", "active");
        } else {
          this.updateStatus("Opponent's turn... ⏳", "active");
        }
        break;
      case "finished":
        // Status will be updated by gameEnd handler
        break;
    }
  }

  resetGame() {
    this.socket.emit("resetGame", { room: this.roomId });
  }

  highlightWinningCells() {
    if (!this.gameState || !this.gameState.winner || this.gameState.winner === "tie") return;

    const winPatterns = [
      [0,1,2], [3,4,5], [6,7,8], // rows
      [0,3,6], [1,4,7], [2,5,8], // columns
      [0,4,8], [2,4,6] // diagonals
    ];

    for (const pattern of winPatterns) {
      const [a, b, c] = pattern;
      if (this.gameState.board[a] && 
          this.gameState.board[a] === this.gameState.board[b] && 
          this.gameState.board[a] === this.gameState.board[c]) {
        
        const cells = document.querySelectorAll(".cell");
        pattern.forEach(index => {
          cells[index].classList.add("winning");
        });
        break;
      }
    }
  }

  showGameEndOverlay(title, message) {
    const overlay = document.getElementById("board-overlay");
    const overlayMessage = document.getElementById("overlay-message");
    const overlayAction = document.getElementById("overlay-action");
    
    overlayMessage.innerHTML = `
      <h2>${title}</h2>
      <p>${message}</p>
    `;
    
    overlayAction.textContent = "Play Again";
    overlayAction.style.display = "block";
    overlayAction.onclick = () => this.resetGame();
    
    overlay.classList.add("show");
  }

  hideGameEndOverlay() {
    const overlay = document.getElementById("board-overlay");
    overlay.classList.remove("show");
  }

  enableResetButton() {
    const resetBtn = document.getElementById("reset-btn");
    resetBtn.disabled = false;
  }

  updateInviteUrl() {
    const inviteUrl = `${window.location.origin}/game.html?room=${this.roomId}`;
    // Store for copy function
    this.inviteUrl = inviteUrl;
  }

  sendMessage() {
    const messageInput = document.getElementById("message-input");
    const message = messageInput.value.trim();
    
    if (!message) return;
    
    this.socket.emit("chatMessage", {
      room: this.roomId,
      message
    });
    
    messageInput.value = "";
  }

  addChatMessage(message) {
    const chatMessages = document.getElementById("chat-messages");
    const messageDiv = document.createElement("div");
    messageDiv.className = "chat-message";
    
    const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    
    messageDiv.innerHTML = `
      <img src="${message.avatar}" alt="${message.player}" class="chat-avatar">
      <div class="chat-content">
        <div class="chat-author">
          ${message.player}
          <span class="chat-timestamp">${timestamp}</span>
        </div>
        <div class="chat-text">${this.escapeHtml(message.message)}</div>
      </div>
    `;
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showNotification(message, type = "info") {
    // Create notification element
    const notification = document.createElement("div");
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    // Add styles
    Object.assign(notification.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      padding: "1rem 1.5rem",
      borderRadius: "8px",
      color: "white",
      fontWeight: "600",
      zIndex: "1000",
      animation: "slideInRight 0.3s ease-out",
      maxWidth: "300px",
      wordWrap: "break-word"
    });
    
    // Set background color based on type
    const colors = {
      info: "#3b82f6",
      success: "#10b981",
      warning: "#f59e0b",
      error: "#ef4444"
    };
    notification.style.backgroundColor = colors[type] || colors.info;
    
    document.body.appendChild(notification);
    
    // Remove after 4 seconds
    setTimeout(() => {
      notification.style.animation = "slideOutRight 0.3s ease-in";
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 300);
    }, 4000);
  }

  playSound(type) {
    try {
      const audio = document.getElementById(`${type}-sound`);
      if (audio) {
        audio.currentTime = 0;
        audio.play().catch(e => console.log("Could not play sound:", e));
      }
    } catch (error) {
      console.log("Sound playback failed:", error);
    }
  }

  toggleChat() {
    const chatSection = document.getElementById("chat-section");
    const chatToggle = document.getElementById("chat-toggle");
    
    this.chatVisible = !this.chatVisible;
    
    if (this.chatVisible) {
      chatSection.style.display = "flex";
      chatToggle.textContent = "Hide";
    } else {
      chatSection.style.display = "none";
      chatToggle.textContent = "Show";
    }
  }
}

// Global functions for HTML onclick handlers
function resetGame() {
  if (window.game) {
    window.game.resetGame();
  }
}

function copyInviteLink() {
  if (window.game && window.game.inviteUrl) {
    navigator.clipboard.writeText(window.game.inviteUrl).then(() => {
      window.game.showNotification("Invite link copied to clipboard!", "success");
    }).catch(() => {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = window.game.inviteUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      window.game.showNotification("Invite link copied to clipboard!", "success");
    });
  }
}

function leaveGame() {
  if (confirm("Are you sure you want to leave the game?")) {
    window.location.href = "/";
  }
}

function sendMessage() {
  if (window.game) {
    window.game.sendMessage();
  }
}

function toggleChat() {
  if (window.game) {
    window.game.toggleChat();
  }
}

// Add notification animations to CSS
const style = document.createElement('style');
style.textContent = `
  @keyframes slideInRight {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOutRight {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(100%);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

// Initialize game when page loads
document.addEventListener("DOMContentLoaded", () => {
  window.game = new XOGame();
});