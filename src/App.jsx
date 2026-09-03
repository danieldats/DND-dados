import React, { useEffect, useState, useCallback } from "react";
import { io } from "socket.io-client";
import { Plus, Trash2, Dices, Award, UserCheck, ShieldAlert, BookOpen, HelpCircle, Code, Play } from "lucide-react";

const socket = io();

/* ======================================================================
   1. MOTOR DE FÓRMULAS Y EVALUADOR
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
    note = ` → conserva [${kept.map((r) => r.value).join(", ")}]`;
  } else if (keepLow !== null) {
    kept = [...rolls].sort((a, b) => a.value - b.value).slice(0, keepLow);
    note = ` → conserva [${kept.map((r) => r.value).join(", ")}]`;
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
      if (!peek() || peek().value !== ")") throw new Error("Falta paréntesis de cierre");
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

function evaluateFormula(formula, stats, saves, skills, profBonus) {
  const trace = [];
  const statLookup = {};

  stats.forEach((s) => {
    statLookup[s.name.trim().toLowerCase()] = Number(s.mod) || 0;
  });

  statLookup["comp"] = Number(profBonus) || 0;

  saves.forEach((sv) => {
    const parentStat = stats.find((s) => s.name === sv.stat);
    const statMod = parentStat ? parentStat.mod : 0;
    const bonus = statMod + (sv.proficient ? profBonus : 0);
    statLookup[`salv_${sv.stat.toLowerCase()}`] = bonus;
  });

  skills.forEach((sk) => {
    const parentStat = stats.find((s) => s.name === sk.stat);
    const statMod = parentStat ? parentStat.mod : 0;
    statLookup[sk.name.trim().toLowerCase()] = statMod + sk.profLevel * profBonus;
  });

  const locals = {};
  const getVar = (name) => {
    const key = name.trim().toLowerCase();
    if (key in locals) return locals[key];
    if (key in statLookup) return statLookup[key];
    trace.push(`⚠ "${name}" no existe, se usó 0`);
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
   2. DATOS INICIALES D&D 5E
   ====================================================================== */
const calcMod = (score) => Math.floor((Number(score) - 10) / 2);
const calcProf = (level) => Math.floor((Math.max(1, Number(level)) - 1) / 4) + 2;

const INITIAL_STATS = [
  { id: "s1", name: "FUE", score: 16, mod: 3 },
  { id: "s2", name: "DES", score: 14, mod: 2 },
  { id: "s3", name: "CON", score: 14, mod: 2 },
  { id: "s4", name: "INT", score: 10, mod: 0 },
  { id: "s5", name: "SAB", score: 12, mod: 1 },
  { id: "s6", name: "CAR", score: 8, mod: -1 },
];

const INITIAL_SAVES = [
  { id: "sv1", stat: "FUE", proficient: true },
  { id: "sv2", stat: "DES", proficient: false },
  { id: "sv3", stat: "CON", proficient: true },
  { id: "sv4", stat: "INT", proficient: false },
  { id: "sv5", stat: "SAB", proficient: false },
  { id: "sv6", stat: "CAR", proficient: false },
];

const INITIAL_SKILLS = [
  { id: "sk1", name: "Acrobacias", stat: "DES", profLevel: 0 },
  { id: "sk2", name: "Atletismo", stat: "FUE", profLevel: 1 },
  { id: "sk3", name: "Arcanos", stat: "INT", profLevel: 0 },
  { id: "sk4", name: "Engaño", stat: "CAR", profLevel: 0 },
  { id: "sk5", name: "Historia", stat: "INT", profLevel: 0 },
  { id: "sk6", name: "Interpretacion", stat: "CAR", profLevel: 0 },
  { id: "sk7", name: "Intimidacion", stat: "CAR", profLevel: 0 },
  { id: "sk8", name: "Investigacion", stat: "INT", profLevel: 0 },
  { id: "sk9", name: "Medicina", stat: "SAB", profLevel: 0 },
  { id: "sk10", name: "Naturaleza", stat: "INT", profLevel: 0 },
  { id: "sk11", name: "Percepcion", stat: "SAB", profLevel: 1 },
  { id: "sk12", name: "Perspicacia", stat: "SAB", profLevel: 0 },
  { id: "sk13", name: "Persuasion", stat: "CAR", profLevel: 0 },
  { id: "sk14", name: "Religion", stat: "INT", profLevel: 0 },
  { id: "sk15", name: "Sigilo", stat: "DES", profLevel: 2 },
  { id: "sk16", name: "Supervivencia", stat: "SAB", profLevel: 0 },
  { id: "sk17", name: "Trato con Animales", stat: "SAB", profLevel: 0 },
  { id: "sk18", name: "Juego de Manos", stat: "DES", profLevel: 0 },
];

const INITIAL_ACTIONS = [
  { id: "a1", name: "Ataque Espada Larga", formula: "1d20 + FUE + COMP" },
  { id: "a2", name: "Daño Espada A dos Manos", formula: "1d10 + FUE" },
  { id: "a3", name: "Ataque Furia (Ventaja)", formula: "2d20kh1 + FUE + COMP" },
  { id: "a4", name: "Ataque Furia de Mandoble", formula: "d = 1d20 + FUE + COMP; dmg = 2d6r1r2 + FUE; d" },
];

export default function App() {
  const [playerName, setPlayerName] = useState("Jugador");
  const [isDM, setIsDM] = useState(false);
  const [level, setLevel] = useState(5);
  const [stats, setStats] = useState(INITIAL_STATS);
  const [saves, setSaves] = useState(INITIAL_SAVES);
  const [skills, setSkills] = useState(INITIAL_SKILLS);
  const [actions, setActions] = useState(INITIAL_ACTIONS);
  const [log, setLog] = useState([]);

  // Formulario nueva acción
  const [newActionName, setNewActionName] = useState("");
  const [newActionFormula, setNewActionFormula] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  const profBonus = calcProf(level);

  useEffect(() => {
    socket.on("init_state", (data) => { if (data.log) setLog(data.log); });
    socket.on("log_updated", (newLog) => setLog(newLog));

    return () => {
      socket.off("init_state");
      socket.off("log_updated");
    };
  }, []);

  const updateStatScore = (id, newScore) => {
    setStats((prev) =>
      prev.map((s) => (s.id === id ? { ...s, score: newScore, mod: calcMod(newScore) } : s))
    );
  };

  const toggleSaveProf = (id) => {
    setSaves((prev) =>
      prev.map((sv) => (sv.id === id ? { ...sv, proficient: !sv.proficient } : sv))
    );
  };

  const toggleSkillProf = (id) => {
    setSkills((prev) =>
      prev.map((sk) => (sk.id === id ? { ...sk, profLevel: (sk.profLevel + 1) % 3 } : sk))
    );
  };

  const addCustomAction = (e) => {
    e.preventDefault();
    if (!newActionName.trim() || !newActionFormula.trim()) return;

    setActions([
      ...actions,
      { id: `act_${Date.now()}`, name: newActionName.trim(), formula: newActionFormula.trim() },
    ]);

    setNewActionName("");
    setNewActionFormula("");
  };

  const removeAction = (id) => {
    setActions(actions.filter((a) => a.id !== id));
  };

  const rollDirect = useCallback((name, formula) => {
    try {
      const { total, trace } = evaluateFormula(formula, stats, saves, skills, profBonus);

      const entry = {
        id: `log_${Date.now()}`,
        player: playerName,
        actionName: name,
        total,
        trace,
        ts: Date.now()
      };

      socket.emit("roll_action", entry);
    } catch (e) {
      alert(`Error en fórmula: ${e.message}`);
    }
  }, [stats, saves, skills, profBonus, playerName]);

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-6 text-white font-sans">
      {/* CABECERA */}
      <header className="flex justify-between items-center bg-slate-900 p-4 rounded-lg border border-slate-800 shadow-md">
        <h1 className="text-xl font-bold flex items-center gap-2 text-indigo-400">
          <Dices /> VTT Dice Roller - D&D 5e
        </h1>
        <div className="flex gap-4 items-center">
          <input
            type="text"
            className="bg-slate-950 px-3 py-1 rounded border border-slate-700 text-sm font-semibold text-amber-300"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
          />
          <button
            onClick={() => setIsDM(!isDM)}
            className={`px-3 py-1 rounded text-xs font-bold flex items-center gap-1 ${isDM ? 'bg-amber-600' : 'bg-slate-800'}`}
          >
            <UserCheck size={14} /> {isDM ? "Modo DJ" : "Jugador"}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* COLUMNA 1: ATRIBUTOS Y SALVACIONES */}
        <div className="lg:col-span-3 space-y-4">
          <div className="bg-slate-900 p-4 rounded-lg border border-slate-800 space-y-4">
            
            {/* NIVEL */}
            <div className="flex justify-between items-center bg-slate-950 p-2.5 rounded border border-slate-800">
              <div className="flex items-center gap-2">
                <Award className="text-amber-400" size={20} />
                <span className="text-xs font-bold">NIVEL</span>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={level}
                  onChange={(e) => setLevel(Number(e.target.value))}
                  className="bg-slate-900 border border-slate-700 w-12 text-center rounded text-sm font-bold"
                />
              </div>
              <div className="text-right">
                <span className="text-xs text-slate-400 block font-semibold">COMPETENCIA</span>
                <span className="text-amber-400 font-extrabold">+{profBonus}</span>
              </div>
            </div>

            {/* ATRIBUTOS */}
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Características</h3>
            <div className="grid grid-cols-3 gap-2">
              {stats.map((s) => (
                <div key={s.id} className="bg-slate-950 p-2 rounded text-center border border-slate-800">
                  <div className="text-xs font-bold text-indigo-400">{s.name}</div>
                  <div className="text-lg font-black my-0.5">{s.mod >= 0 ? `+${s.mod}` : s.mod}</div>
                  <input
                    type="number"
                    value={s.score}
                    onChange={(e) => updateStatScore(s.id, e.target.value)}
                    className="bg-slate-900 border border-slate-700 w-10 text-center rounded text-xs"
                  />
                </div>
              ))}
            </div>

            {/* SALVACIONES */}
            <div className="pt-2 border-t border-slate-800">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1">
                <ShieldAlert size={14} className="text-red-400" /> Tiradas de Salvación
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {saves.map((sv) => {
                  const parentStat = stats.find((s) => s.name === sv.stat);
                  const total = (parentStat ? parentStat.mod : 0) + (sv.proficient ? profBonus : 0);
                  return (
                    <div key={sv.id} className="flex justify-between items-center bg-slate-950 p-2 rounded text-xs border border-slate-800">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleSaveProf(sv.id)}
                          className={`w-3.5 h-3.5 rounded-full border ${sv.proficient ? "bg-amber-500 border-amber-400" : "border-slate-700"}`}
                        />
                        <span className="font-bold">{sv.stat}</span>
                      </div>
                      <button
                        onClick={() => rollDirect(`Salvación ${sv.stat}`, `1d20 + SALV_${sv.stat}`)}
                        className="font-bold text-amber-300 hover:text-white px-1.5 py-0.5 bg-slate-900 rounded"
                      >
                        {total >= 0 ? `+${total}` : total}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        </div>

        {/* COLUMNA 2: HABILIDADES */}
        <div className="lg:col-span-3 bg-slate-900 p-4 rounded-lg border border-slate-800 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
            <BookOpen size={14} className="text-indigo-400" /> Habilidades
          </h3>
          <div className="space-y-1 max-h-[500px] overflow-y-auto pr-1">
            {skills.map((sk) => {
              const parentStat = stats.find((s) => s.name === sk.stat);
              const total = (parentStat ? parentStat.mod : 0) + sk.profLevel * profBonus;
              return (
                <div key={sk.id} className="flex justify-between items-center bg-slate-950 p-1.5 rounded text-xs border border-slate-800 hover:border-slate-700">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleSkillProf(sk.id)}
                      className={`w-4 h-4 rounded-full text-[9px] font-bold border flex items-center justify-center ${
                        sk.profLevel === 2 ? "bg-amber-500 text-black border-amber-300" : sk.profLevel === 1 ? "bg-indigo-600 text-white border-indigo-400" : "border-slate-700 text-transparent"
                      }`}
                    >
                      {sk.profLevel === 2 ? "x2" : "✓"}
                    </button>
                    <span className="font-medium">{sk.name}</span>
                    <span className="text-[10px] text-slate-500">({sk.stat})</span>
                  </div>
                  <button
                    onClick={() => rollDirect(sk.name, `1d20 + ${sk.name.replace(/\s+/g, '')}`)}
                    className="font-bold text-indigo-300 hover:text-white bg-slate-900 px-2 py-0.5 rounded border border-slate-800"
                  >
                    {total >= 0 ? `+${total}` : total}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* COLUMNA 3: ACCIONES PERSONALIZADAS Y CREACIÓN */}
        <div className="lg:col-span-6 space-y-4">
          
          {/* PANEL DE ACCIONES */}
          <div className="bg-slate-900 p-4 rounded-lg border border-slate-800 space-y-4">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
              <h2 className="font-bold text-sm text-slate-300 flex items-center gap-2">
                <Code size={16} className="text-amber-400" /> Acciones Personalizadas
              </h2>
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="text-xs bg-slate-800 hover:bg-slate-700 text-amber-400 font-semibold px-2 py-1 rounded flex items-center gap-1"
              >
                <HelpCircle size={14} /> Sintaxis & Variables
              </button>
            </div>

            {/* GUÍA DE SINTAXIS (DESPLEGABLE) */}
            {showHelp && (
              <div className="bg-slate-950 p-3 rounded border border-slate-800 text-xs space-y-2 text-slate-300 font-mono">
                <div className="font-bold text-amber-400 font-sans border-b border-slate-800 pb-1">
                  Manual del Motor de Tiradas:
                </div>
                <div><span className="text-indigo-400">Dados Básicos:</span> <code className="text-white">1d20</code>, <code className="text-white">2d6</code>, <code className="text-white">1d100</code></div>
                <div><span className="text-indigo-400">Ventaja/Desventaja:</span> <code className="text-white">2d20kh1</code> (Conserva mayor), <code className="text-white">2d20kl1</code> (Conserva menor)</div>
                <div><span className="text-indigo-400">Repetir Dados (Estilo Estilista/Mandoble):</span> <code className="text-white">2d6r1r2</code> (Repite 1s y 2s una vez)</div>
                <div><span className="text-indigo-400">Variables de Atributos:</span> <code className="text-white">FUE</code>, <code className="text-white">DES</code>, <code className="text-white">CON</code>, <code className="text-white">INT</code>, <code className="text-white">SAB</code>, <code className="text-white">CAR</code>, <code className="text-white">COMP</code></div>
                <div><span className="text-indigo-400">Salvaciones:</span> <code className="text-white">SALV_FUE</code>, <code className="text-white">SALV_DES</code>, etc.</div>
                <div><span className="text-indigo-400">Habilidades:</span> <code className="text-white">ATLETISMO</code>, <code className="text-white">PERCEPCION</code>, <code className="text-white">SIGILO</code>, etc.</div>
                <div><span className="text-indigo-400">Asignaciones Multi-Paso:</span> <code className="text-white">d = 1d20 + FUE; dmg = 2d6; d</code> (Devuelve la última variable)</div>
              </div>
            )}

            {/* FORMULARIO CREAR ACCIÓN */}
            <form onSubmit={addCustomAction} className="grid grid-cols-1 sm:grid-cols-12 gap-2 bg-slate-950 p-2.5 rounded border border-slate-800">
              <input
                type="text"
                placeholder="Nombre (ej. Ataque Furia)"
                value={newActionName}
                onChange={(e) => setNewActionName(e.target.value)}
                className="sm:col-span-4 bg-slate-900 border border-slate-700 px-2.5 py-1 rounded text-xs text-white"
              />
              <input
                type="text"
                placeholder="Fórmula (ej. 2d20kh1 + FUE + COMP)"
                value={newActionFormula}
                onChange={(e) => setNewActionFormula(e.target.value)}
                className="sm:col-span-6 bg-slate-900 border border-slate-700 px-2.5 py-1 rounded text-xs font-mono text-amber-300"
              />
              <button
                type="submit"
                className="sm:col-span-2 bg-indigo-600 hover:bg-indigo-500 font-bold text-xs rounded px-2 py-1 flex items-center justify-center gap-1"
              >
                <Plus size={14} /> Crear
              </button>
            </form>

            {/* LISTA DE ACCIONES */}
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {actions.map((act) => (
                <div key={act.id} className="bg-slate-950 p-2.5 rounded border border-slate-800 flex justify-between items-center hover:border-slate-700">
                  <div className="space-y-0.5">
                    <div className="font-bold text-xs text-white">{act.name}</div>
                    <div className="text-[10px] text-amber-400 font-mono">{act.formula}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => rollDirect(act.name, act.formula)}
                      className="bg-indigo-600 hover:bg-indigo-500 px-3 py-1 rounded flex items-center gap-1 text-xs font-bold"
                    >
                      <Play size={12} /> Tirar
                    </button>
                    <button
                      onClick={() => removeAction(act.id)}
                      className="text-slate-600 hover:text-red-400 p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* HISTORIAL / REGISTRO DE MESA */}
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 h-64 flex flex-col">
            <h2 className="text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">Registro de la Mesa</h2>
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {log.map((entry) => (
                <div key={entry.id} className="bg-slate-900 p-2 rounded text-xs border-l-2 border-indigo-500">
                  <div className="flex justify-between text-slate-500 text-[10px] mb-0.5">
                    <span className="font-bold text-indigo-300">{entry.player}</span>
                    <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                  </div>
                  <div className="font-semibold text-xs">{entry.actionName}: <span className="text-amber-400 text-sm font-bold">{entry.total}</span></div>
                  <div className="text-slate-500 font-mono text-[9px] mt-0.5">{entry.trace?.join(" | ")}</div>
                </div>
              ))}
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
