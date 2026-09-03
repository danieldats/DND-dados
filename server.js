const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "dist")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Estado global de la mesa/sala
const gameLog = [];
const activeSheets = {};

io.on("connection", (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);

  // Enviar estado actual al nuevo jugador
  socket.emit("init_state", { log: gameLog, sheets: activeSheets });

  // Escuchar tiradas de dados
  socket.on("roll_action", (entry) => {
    gameLog.unshift(entry);
    if (gameLog.length > 100) gameLog.pop(); // Mantener solo los últimos 100
    io.emit("log_updated", gameLog); // Transmitir a TODOS los clientes
  });

  // Escuchar actualización de ficha
  socket.on("update_sheet", ({ id, name, sheetData }) => {
    activeSheets[id] = { id, name, ...sheetData };
    io.emit("sheets_updated", activeSheets);
  });

  // Eliminar ficha
  socket.on("delete_sheet", (id) => {
    delete activeSheets[id];
    io.emit("sheets_updated", activeSheets);
  });

  socket.on("disconnect", () => {
    console.log(`Usuario desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));