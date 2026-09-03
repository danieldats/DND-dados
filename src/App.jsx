import React, { useEffect, useState, useCallback } from "react";
import { io } from "socket.io-client";
import { Plus, Trash2, Dices, Info, X, Lock, RefreshCw, UserCheck } from "lucide-react";

// Conexión dinámica (al mismo host en producción)
const socket = io();

/* ======================================================================
   MOTOR DE FÓRMULAS Y SINTAXIS (SIN CAMBIOS)
   ====================================================================== */
function tokenize(input) {
  const tokens = [];
  const s = input.replace(/\s+/g, "");
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = rest.match(/^(\d*)d(\d+)((?:r{1,2}\d+|k[hl]\d+)*)/i))) {
      tokens.push({
        type: "dice",
        count: m[1] ? parseInt(m[1], 10) : 1,
        sides: parseInt(m[2], 10),
        mods: m[3] || "",
      });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\d+(?:\.\d+)?/))) {
      tokens.push({ type: "number", value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^[A-Za-zÁÉÍÓÚÑáéíóúñ_][A-Za-z0-9ÁÉÍÓÚÑáéíóúñ_]*/))) {
      tokens.push({ type: "ident", value: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^(==|!=|>=|<=|&&|\|\|)/))) {
      tokens.push({ type: "op", value: m[0] });
      i += m[0].length;
      continue;
    }
    if ("+-*/(),<>;=".includes(rest[0])) {
      tokens.push({ type: "op", value: rest[0] });
      i += 1;
      continue;
    }
    throw new Error(`Símbolo no reconocido cerca de "${rest.slice(0, 6)}"`);
  }
  return tokens;
}

function rollDice(count, sides, modsStr, trace) {
  const mods = [...modsStr.matchAll(/r{1,2}\d+|k[hl]\d+/gi)].map((m) => m[0]);
  let rerollAlways = null, rerollOnce = null, keepHigh = null, keepLow = null;
  for (const t of mods) {
    if (/^rr/i.test(t)) rerollAlways = parseInt(t.slice(2), 10);
    else if (/^r/i.test(t)) rerollOnce = parseInt(t.slice(1), 10);
    else if (/^kh/i.test(t)) keepHigh = parseInt(t.slice(2), 10);
    else if (/^kl/i.test(t)) keepLow = parseInt(t.slice(2), 10);
  }

  const rolls = [];
  for (let n = 0; n < count; n++) {
    let val = 1 + Math.floor(Math.random() * sides);
    let history = [val];
    if (rerollAlways !== null) {
      let attempts = 0;
      while (val === rerollAlways && attempts < 100) {
        val = 1 + Math.floor(Math.random() * sides);
        history.push(val);
        attempts++;
      }
    } else if (rerollOnce !== null && val === rerollOnce) {
      val = 1 + Math.floor(Math.random() * sides);
      history.push(val);
    }
    rolls.push({ value: val, history });
  }

  let kept = rolls;
  let note = "";
  if (keepHigh !== null) {
    kept = [...rolls].sort((a, b) => b.value - a.value).slice(0, keepHigh);
    note = ` → se queda con ${kept.map((r) => r.value).join(", ")}`;
  } else if (keepLow !== null) {
    kept = [...rolls].sort((a, b) => a.value - b.value).slice(0, keepLow);
    note = ` → se queda con ${kept.map((r) => r.value).join(", ")}`;
  }
  const total = kept.reduce((s, r) => s + r.value, 0);
  const rollsText = rolls
    .map((r) => (r.history.length > 1 ? r.history.join("→") : `${r.value}`))
    .join(", ");
  trace.push(`${count}d${sides}${modsStr} → [${rollsText}]${note} = ${total}`);
  return total;
}

function parseExpr(tokens, getVar, trace) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseArgs() {
    const args = [parseOr()];
    while (peek() && peek().type === "op" && peek().value === ",") {
      next();
      args.push(parseOr());
    }
    return args;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error("Fórmula incompleta");
    if (t.type === "number") { next(); return t.value; }
    if (t.type === "dice") { next(); return rollDice(t.count, t.sides, t.mods, trace); }
    if (t.type === "op" && t.value === "(") {
      next();
      const v = parseOr();
      if (!peek() || peek().value !== ")") throw new Error("Falta un paréntesis de cierre");
      next();
      return v;
    }
    if (t.type === "op" && t.value === "-") { next(); return -parsePrimary(); }
    if (t.type === "ident") {
      next();
      const name = t.value;
      if (peek() && peek().type === "op" && peek().value === "(") {
        next();
        const args = peek() && peek().value === ")" ? [] : parseArgs();
        if (!peek() || peek().value !== ")") throw new Error(`Falta ")" en ${name}(...)`);
        next();
        return callFunction(name, args);
      }
      return getVar(name);
    }
    throw new Error(`Token inesperado: ${JSON.stringify(t)}`);
  }

  function callFunction(name, args) {
    const fn = name.toLowerCase();
    switch (fn) {
      case "max": return Math.max(...args);
      case "min": return Math.min(...args);
      case "sum": return args.reduce((a, b) => a + b, 0);
      case "floor": return Math.floor(args[0]);
      case "ceil": return Math.ceil(args[0]);
      case "round": return Math.round(args[0]);
      case "abs": return Math.abs(args[0]);
      case "if":
        if (args.length !== 3) throw new Error("if(cond, valSi, valNo) requiere 3 argumentos");
        return args[0] ? args[1] : args[2];
      default: throw new Error(`Función desconocida: ${name}`);
    }
  }

  function parseUnary() { return parsePrimary(); }
  function parseTerm() {
    let v = parseUnary();
    while (peek() && peek().type === "op" && (peek().value === "*" || peek().value === "/")) {
      const op = next().value;
      const r = parseUnary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function parseAdd() {
    let v = parseTerm();
    while (peek() && peek().type === "op" && (peek().value === "+" || peek().value === "-")) {
      const op = next().value;
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function parseCompare() {
    let v = parseAdd();
    while (peek() && peek().type === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(peek().value)) {
      const op = next().value;
      const r = parseAdd();
      if (op === "==") v = v === r ? 1 : 0;
      else if (op === "!=") v = v !== r ? 1 : 0;
      else if (op === ">=") v = v >= r ? 1 : 0;
      else if (op === "<=") v = v <= r ? 1 : 0;
      else if (op === ">") v = v > r ? 1 : 0;
      else if (op === "<") v = v < r ? 1 : 0;
    }
    return v;
  }
  function parseAnd() {
    let v = parseCompare();
    while (peek() && peek().value === "&&") {
      next();
      const r = parseCompare();
      v = v && r ? 1 : 0;
    }
    return v;
  }
  function parseOr() {
    let v = parseAnd();
    while (peek() && peek().value === "||") {
      next();
      const r = parseAnd();
      v = v || r ? 1 : 0;
    }
    return v;
  }

  const result = parseOr();
  if (pos < tokens.length) throw new Error(`Sobra texto cerca de "${tokens[pos].value ?? ""}"`);
  return result;
}

function evaluateFormula(formula, stats, flags) {
  const trace = [];
  const statLookup = {};
  stats.forEach((s) => { statLookup[s.name.trim().toLowerCase()] = Number(s.value) || 0; });
  flags.forEach((f) => { statLookup[f.name.trim().toLowerCase()] = f.value ? 1 : 0; });
  const locals = {};

  const getVar = (name) => {
    const key = name.trim().toLowerCase();
    if (key in locals) return locals[key];
    if (key in statLookup) return statLookup[key];
    trace.push(`⚠ Variable "${name}" no existe, usando 0`);
    return 0;
  };

  const tokens = tokenize(formula);
  const statements = [];
  let current = [];
  for (const t of tokens) {
    if (t.type === "op" && t.value === ";") {
      statements.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  statements.push(current);

  let total = 0;
  statements.forEach((stmt) => {
    if (stmt.length === 0) return;
    const isAssignment = stmt[0].type === "ident" && stmt[1] && stmt[1].type === "op" && stmt[1].value === "=";
    if (isAssignment) {
      const name = stmt[0].value;
      const exprTokens = stmt.slice(2);
      const value = parseExpr(exprTokens, getVar, trace);
      locals[name.trim().toLowerCase()] = value;
      trace.push(`${name} = ${value}`);
      total = value;
    } else {
      total = parseExpr(stmt, getVar, trace);
    }
  });

  return { total, trace };
}

/* ======================================================================
   APLICACIÓN PRINCIPAL REACT CON MULTIJUGADOR SINCRO
   ====================================================================== */
const DEFAULT_STATS = [
  { id: "s1", name: "FUE", value: 3 },
  { id: "s2", name: "DES", value: 2 },
  { id: "s3", name: "COMP", value: 3 }
];
const DEFAULT_ACTIONS = [
  { id: "a1", name: "Ataque Espada", formula: "1d20 + FUE + COMP", private: false },
  { id: "a2", name: "Daño Espada", formula: "1d8 + FUE", private: false }
];

export default function App() {
  const [playerName, setPlayerName] = useState("Jugador");
  const [isDM, setIsDM] = useState(false);
  const [stats, setStats] = useState(DEFAULT_STATS);
  const [flags, setFlags] = useState([]);
  const [actions, setActions] = useState(DEFAULT_ACTIONS);
  const [log, setLog] = useState([]);
  const [results, setResults] = useState({});

  useEffect(() => {
    // Sincronización socket.io
    socket.on("init_state", (data) => {
      if (data.log) setLog(data.log);
    });

    socket.on("log_updated", (newLog) => {
      setLog(newLog);
    });

    return () => {
      socket.off("init_state");
      socket.off("log_updated");
    };
  }, []);

  const roll = useCallback((action) => {
    try {
      const { total, trace } = evaluateFormula(action.formula, stats, flags);
      setResults((prev) => ({ ...prev, [action.id]: { total, trace } }));

      const entry = {
        id: `log_${Date.now()}`,
        player: playerName,
        actionName: action.name,
        total,
        trace,
        private: !!action.private,
        ts: Date.now()
      };

      // Emitir tirada a todos los miembros de la sala
      socket.emit("roll_action", entry);
    } catch (e) {
      alert(`Error en fórmula: ${e.message}`);
    }
  }, [stats, flags, playerName]);

  return (
    <div className="p-4 max-w-4xl mx-auto bg-slate-900 text-white rounded-lg shadow-xl font-sans">
      <header className="flex justify-between items-center border-b border-slate-700 pb-4 mb-4">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Dices className="text-indigo-400" /> VTT Tabletop Roller
        </h1>
        <div className="flex gap-4 items-center">
          <input
            type="text"
            className="bg-slate-800 px-2 py-1 rounded border border-slate-600 text-sm"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
          />
          <button
            onClick={() => setIsDM(!isDM)}
            className={`px-3 py-1 rounded text-xs flex items-center gap-1 ${isDM ? 'bg-amber-600' : 'bg-slate-700'}`}
          >
            <UserCheck size={14} /> {isDM ? "Modo DM" : "Jugador"}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Acciones */}
        <div className="space-y-4">
          <h2 className="font-semibold border-b border-slate-800 pb-1">Acciones</h2>
          {actions.map((act) => (
            <div key={act.id} className="bg-slate-800 p-3 rounded flex justify-between items-center">
              <div>
                <div className="font-medium text-sm">{act.name}</div>
                <div className="text-xs text-slate-400">{act.formula}</div>
              </div>
              <button
                onClick={() => roll(act)}
                className="bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 rounded flex items-center gap-1 text-sm font-medium"
              >
                <Dices size={16} /> Tirar
              </button>
            </div>
          ))}
        </div>

        {/* Registro en tiempo real */}
        <div className="bg-slate-950 p-3 rounded border border-slate-800 h-96 flex flex-col">
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Registro de la Mesa</h2>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {log.map((entry) => {
              if (entry.private && !isDM && entry.player !== playerName) return null;
              return (
                <div key={entry.id} className="bg-slate-900 p-2 rounded text-xs border-l-2 border-indigo-500">
                  <div className="flex justify-between text-slate-400 mb-1">
                    <span className="font-bold text-indigo-300">{entry.player}</span>
                    <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                  </div>
                  <div className="font-semibold text-sm mb-1">{entry.actionName}: <span className="text-amber-400 text-base">{entry.total}</span></div>
                  <div className="text-slate-500 font-mono text-[10px]">{entry.trace?.join(" | ")}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}