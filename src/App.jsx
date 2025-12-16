import React, { useState, useEffect, useRef, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  signInWithCustomToken,
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  onSnapshot, 
  updateDoc, 
  arrayUnion,
  increment,
  serverTimestamp
} from 'firebase/firestore';
import { AlertCircle, Play, Users, Trophy, Snowflake, RefreshCw, Hand, Shield, Flag, Clock, Zap } from 'lucide-react';

// --- Configuration Helper ---
const getFirebaseConfig = () => {
  if (typeof __firebase_config !== 'undefined') {
    return JSON.parse(__firebase_config);
  }
  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };
};

const getAppId = () => {
  if (typeof __app_id !== 'undefined') {
    return __app_id;
  }
  return import.meta.env.VITE_GAME_APP_ID || 'dualitaire-default';
};

// --- Firebase Initialization ---
const firebaseConfig = getFirebaseConfig();
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = getAppId();

// --- Game Constants ---
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const ATTACK_THRESHOLD = 2; 
const GAME_DURATION_SEC = 180; 
const COMBO_WINDOW_MS = 3000; 

const createDeck = () => {
  const deck = [];
  SUITS.forEach(suit => {
    RANKS.forEach((rank, index) => {
      deck.push({
        id: `${suit}-${rank}`,
        suit,
        rank,
        value: index + 1,
        color: (suit === '♥' || suit === '♦') ? 'red' : 'black',
        faceUp: false,
      });
    });
  });
  return shuffle(deck);
};

const shuffle = (array) => {
  let currentIndex = array.length, randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
};

// --- Components ---

const Card = ({ card, onClick, isSelected, isFrozen, style }) => {
  // Placeholder for empty slots
  if (!card) return (
    <div 
      className="w-full aspect-[5/7] border-2 border-dashed border-white/10 rounded-md bg-white/5 box-border" 
    />
  );

  // Back of card
  if (!card.faceUp) {
    return (
      <div 
        onClick={onClick}
        className="w-full aspect-[5/7] bg-indigo-900 border border-white/20 rounded-md shadow-sm cursor-pointer relative overflow-hidden box-border"
        style={style}
      >
        <div className="absolute inset-1 border border-indigo-400/30 rounded-sm bg-gradient-to-br from-indigo-800 to-indigo-950 pattern-grid-lg"></div>
      </div>
    );
  }

  // Front of card
  return (
    <div 
      onClick={onClick}
      style={style}
      className={`
        w-full aspect-[5/7] bg-white rounded-md shadow-sm cursor-pointer select-none relative transition-transform duration-100 box-border
        ${isSelected ? 'ring-2 ring-yellow-400 translate-y-[-4px] z-50' : 'active:scale-95'}
        ${isFrozen ? 'after:content-[""] after:absolute after:inset-0 after:bg-blue-400/50 after:backdrop-blur-[1px] after:rounded-md' : ''}
      `}
    >
      {/* Top Left: Rank */}
      <div className={`absolute top-[4%] left-[8%] font-bold leading-none text-[clamp(10px,3vw,18px)] tracking-tighter ${card.color === 'red' ? 'text-red-600' : 'text-gray-900'}`}>
        {card.rank}
      </div>

      {/* Top Right: Suit */}
      <div className={`absolute top-[4%] right-[8%] leading-none text-[clamp(10px,2.5vw,16px)] ${card.color === 'red' ? 'text-red-600' : 'text-gray-900'}`}>
        {card.suit}
      </div>

      {/* Center Suit (Decoration) */}
      <div className={`absolute bottom-[10%] right-[10%] opacity-20 transform scale-[2.5] text-[clamp(12px,4vw,24px)] ${card.color === 'red' ? 'text-red-600' : 'text-gray-900'}`}>
        {card.suit}
      </div>

      {isFrozen && <Snowflake className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-blue-600 w-1/2 h-1/2 animate-pulse" />}
    </div>
  );
};

// --- Main App Component ---

export default function App() {
  const [user, setUser] = useState(null);
  const [roomId, setRoomId] = useState('');
  const [gameState, setGameState] = useState('lobby'); // lobby, waiting, playing, finished
  const [roomData, setRoomData] = useState(null);
  
  // Game Logic State
  const [deck, setDeck] = useState([]);
  const [waste, setWaste] = useState([]);
  const [tableau, setTableau] = useState([]);
  const [foundation, setFoundation] = useState([[], [], [], []]);
  const [selectedCard, setSelectedCard] = useState(null); 
  const [frozenColumns, setFrozenColumns] = useState({}); 
  const [attackCharge, setAttackCharge] = useState(0); 
  const [myScore, setMyScore] = useState(0);
  
  // New Features State
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION_SEC);
  const [combo, setCombo] = useState(0);
  const [lastMoveTime, setLastMoveTime] = useState(0);
  const [comboTimer, setComboTimer] = useState(0); 
  
  // Effects
  const [lastAttackId, setLastAttackId] = useState(null);
  const timerRef = useRef(null);
  const comboIntervalRef = useRef(null);

  // Auth Setup
  useEffect(() => {
    const initAuth = async () => {
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        await signInWithCustomToken(auth, __initial_auth_token);
      } else {
        await signInAnonymously(auth);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // Room Listener & Timer Sync
  useEffect(() => {
    if (!user || !roomId) return;

    const unsub = onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), (docSnapshot) => {
      if (docSnapshot.exists()) {
        const data = docSnapshot.data();
        setRoomData(data);
        
        if (data.status === 'playing' && gameState === 'waiting') {
          startGameLocal();
          setGameState('playing');
        }

        if (data.status === 'finished' && gameState !== 'finished') {
          setGameState('finished');
          if (timerRef.current) clearInterval(timerRef.current);
        }

        if (data.attacks && data.attacks.length > 0) {
          const latestAttack = data.attacks[data.attacks.length - 1];
          if (latestAttack.target === user.uid && latestAttack.id !== lastAttackId) {
            triggerFreezeEffect();
            setLastAttackId(latestAttack.id);
          }
        }
      }
    });

    return () => unsub();
  }, [user, roomId, gameState, lastAttackId]);

  // Timer Logic
  useEffect(() => {
    if (gameState === 'playing' && roomData?.startTime) {
      timerRef.current = setInterval(() => {
        const now = Date.now();
        const elapsedSec = Math.floor((now - roomData.startTime.toMillis()) / 1000);
        const remaining = Math.max(0, GAME_DURATION_SEC - elapsedSec);
        
        setTimeLeft(remaining);

        if (remaining <= 0) {
          clearInterval(timerRef.current);
          handleTimeUp();
        }
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [gameState, roomData]);

  // Combo Timer Logic
  useEffect(() => {
    if (combo > 0) {
      comboIntervalRef.current = setInterval(() => {
        const now = Date.now();
        const diff = now - lastMoveTime;
        const progress = Math.max(0, 100 - (diff / COMBO_WINDOW_MS) * 100);
        setComboTimer(progress);

        if (diff > COMBO_WINDOW_MS) {
          setCombo(0);
          setComboTimer(0);
        }
      }, 100);
    } else {
      setComboTimer(0);
    }
    return () => {
      if (comboIntervalRef.current) clearInterval(comboIntervalRef.current);
    };
  }, [combo, lastMoveTime]);

  // --- Game Mechanics ---

  const startGameLocal = () => {
    const newDeck = createDeck();
    const newTableau = Array(7).fill().map(() => []);
    
    let cardIdx = 0;
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j <= i; j++) {
        const card = newDeck[cardIdx++];
        card.faceUp = (j === i);
        newTableau[i].push(card);
      }
    }
    
    setDeck(newDeck.slice(cardIdx));
    setTableau(newTableau);
    setWaste([]);
    setFoundation([[], [], [], []]);
    setMyScore(0);
    setAttackCharge(0);
    setFrozenColumns({});
    setCombo(0);
  };

  const handleTimeUp = async () => {
    if (!roomData) return;
    const isHost = roomData.host === user.uid;
    const myCurrentScore = myScore;
    const opponentScore = isHost ? roomData.guestScore : roomData.hostScore;
    
    let winnerId = null;
    if (myCurrentScore > opponentScore) winnerId = user.uid;
    else if (opponentScore > myCurrentScore) winnerId = isHost ? roomData.guest : roomData.host;
    else winnerId = 'draw';

    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
        status: 'finished',
        winner: winnerId
    });
  };

  const triggerFreezeEffect = () => {
    const availableCols = tableau.map((col, idx) => col.length > 0 ? idx : -1).filter(idx => idx !== -1);
    if (availableCols.length === 0) return;

    const targetCol = availableCols[Math.floor(Math.random() * availableCols.length)];
    setFrozenColumns(prev => ({
      ...prev,
      [targetCol]: Date.now() + 5000 
    }));

    setTimeout(() => {
      setFrozenColumns(prev => {
        const newState = { ...prev };
        delete newState[targetCol];
        return newState;
      });
    }, 5000);
  };

  const sendAttack = async () => {
    if (!roomData) return;
    const opponentId = roomData.host === user.uid ? roomData.guest : roomData.host;
    if (!opponentId) return;

    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
      attacks: arrayUnion({
        id: crypto.randomUUID(),
        target: opponentId,
        type: 'freeze',
        timestamp: Date.now()
      })
    });
  };

  const updateScore = async (points, isFoundationMove = false) => {
    let multiplier = 1;
    let addedScore = points;

    if (isFoundationMove) {
      const now = Date.now();
      if (now - lastMoveTime < COMBO_WINDOW_MS) {
        const newCombo = combo + 1;
        setCombo(newCombo);
        multiplier = 1 + (newCombo * 0.2); 
      } else {
        setCombo(1);
      }
      setLastMoveTime(now);
      
      addedScore = Math.floor(points * multiplier);

      const chargeAmount = combo > 2 ? 2 : 1;
      const newCharge = attackCharge + chargeAmount;
      if (newCharge >= ATTACK_THRESHOLD) {
        sendAttack();
        setAttackCharge(0);
      } else {
        setAttackCharge(newCharge);
      }
    }

    const newScore = myScore + addedScore;
    setMyScore(newScore);
    
    if (!roomData) return;
    const field = roomData.host === user.uid ? 'hostScore' : 'guestScore';
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
      [field]: newScore
    });

    if (newScore > 5000 && deck.length === 0 && waste.length === 0) {
         await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
            status: 'finished',
            winner: user.uid
        });
    }
  };

  // --- Interaction Logic ---

  const handleStockClick = () => {
    if (deck.length === 0) {
      if (waste.length === 0) return;
      const newDeck = [...waste].map(c => ({...c, faceUp: false}));
      setDeck(newDeck);
      setWaste([]);
      updateScore(-50);
    } else {
      const card = deck[0];
      const newDeck = deck.slice(1);
      const newWaste = [...waste, {...card, faceUp: true}];
      setDeck(newDeck);
      setWaste(newWaste);
    }
    setSelectedCard(null);
  };

  const handleCardClick = (pileType, pileIndex, cardIndex, card) => {
    if (pileType === 'tableau' && frozenColumns[pileIndex]) return;

    // --- Smart Move Logic ---
    const isTopCard = 
      (pileType === 'waste' && cardIndex === waste.length - 1) ||
      (pileType === 'tableau' && cardIndex === tableau[pileIndex].length - 1);

    if (isTopCard && card) {
       for (let fIdx = 0; fIdx < 4; fIdx++) {
           if (isValidFoundationMove(card, fIdx)) {
               executeMove(
                   { pileType, pileIndex, cardIndex, card }, 
                   { pileType: 'foundation', pileIndex: fIdx }
               );
               updateScore(100, true);
               return; 
           }
       }
    }

    // --- Standard Selection Logic ---
    if (!selectedCard) {
      if (!card) return; 
      
      // Auto-flip fallback logic just in case
      if (pileType === 'tableau' && !card.faceUp) {
          if (cardIndex === tableau[pileIndex].length - 1) {
              const newTableau = [...tableau];
              newTableau[pileIndex][cardIndex].faceUp = true;
              setTableau(newTableau);
              updateScore(5);
          }
          return;
      }
      if (pileType === 'foundation') return; 
      
      setSelectedCard({ pileType, pileIndex, cardIndex, card });
      return;
    }

    // --- Move Logic ---
    const source = selectedCard;
    if (source.card.id === card?.id) {
      setSelectedCard(null);
      return;
    }

    if (pileType === 'foundation') {
      if (isValidFoundationMove(source.card, pileIndex)) {
        executeMove(source, { pileType, pileIndex });
        updateScore(100, true);
      } else {
        setSelectedCard(null);
      }
      return;
    }

    if (pileType === 'tableau') {
      if (isValidTableauMove(source.card, pileIndex)) {
        executeMove(source, { pileType, pileIndex });
      } else {
        setSelectedCard(null);
      }
      return;
    }
  };

  const isValidFoundationMove = (card, pileIndex) => {
    const targetPile = foundation[pileIndex];
    if (targetPile.length === 0) {
      return card.rank === 'A';
    }
    const topCard = targetPile[targetPile.length - 1];
    return card.suit === topCard.suit && card.value === topCard.value + 1;
  };

  const isValidTableauMove = (card, pileIndex) => {
    const targetPile = tableau[pileIndex];
    if (targetPile.length === 0) {
      return card.rank === 'K';
    }
    const topCard = targetPile[targetPile.length - 1];
    const isColorDifferent = card.color !== topCard.color;
    const isRankLower = card.value === topCard.value - 1;
    return isColorDifferent && isRankLower;
  };

  const executeMove = (source, dest) => {
    let cardsToMove = [];
    
    // Remove Logic & Auto Flip Check
    if (source.pileType === 'waste') {
      cardsToMove = [waste[waste.length - 1]];
      setWaste(prev => prev.slice(0, -1));
    } else if (source.pileType === 'tableau') {
      const sourceCol = tableau[source.pileIndex];
      cardsToMove = sourceCol.slice(source.cardIndex);
      const newSourceCol = sourceCol.slice(0, source.cardIndex);
      
      // Auto Flip Logic
      const lastIndex = newSourceCol.length - 1;
      if (lastIndex >= 0 && !newSourceCol[lastIndex].faceUp) {
          newSourceCol[lastIndex] = { ...newSourceCol[lastIndex], faceUp: true };
          // We call updateScore(5) below for the flip bonus
          setTimeout(() => updateScore(5), 0);
      }

      setTableau(prev => {
        const newT = [...prev];
        newT[source.pileIndex] = newSourceCol;
        return newT;
      });
    }

    // Add Logic
    if (dest.pileType === 'foundation') {
      setFoundation(prev => {
        const newF = [...prev];
        newF[dest.pileIndex] = [...newF[dest.pileIndex], cardsToMove[0]];
        return newF;
      });
    } else if (dest.pileType === 'tableau') {
      setTableau(prev => {
        const newT = [...prev];
        newT[dest.pileIndex] = [...newT[dest.pileIndex], ...cardsToMove];
        return newT;
      });
    }
    
    setSelectedCard(null);
  };

  // --- Helpers ---

  const createRoom = async () => {
    const newRoomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${newRoomId}`), {
      host: user.uid,
      status: 'waiting',
      hostScore: 0,
      guestScore: 0,
      attacks: [],
      createdAt: serverTimestamp()
    });
    setRoomId(newRoomId);
    setGameState('waiting');
  };

  const joinRoom = async (inputRoomId) => {
    const roomRef = doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${inputRoomId}`);
    await updateDoc(roomRef, {
      guest: user.uid,
      status: 'playing',
      startTime: serverTimestamp() 
    });
    setRoomId(inputRoomId);
    setGameState('playing');
    startGameLocal();
  };

  const handleGiveUp = async () => {
    if (!window.confirm('本当に降参しますか？')) return;
    if (!roomData) return;

    const opponentId = roomData.host === user.uid ? roomData.guest : roomData.host;
    if (!opponentId) {
        setGameState('lobby');
        setRoomId('');
        return;
    }

    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
        status: 'finished',
        winner: opponentId
    });
  };

  // --- Render ---

  if (!user) return <div className="flex items-center justify-center h-screen bg-indigo-900 text-white">Loading Auth...</div>;

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-[100dvh] bg-gradient-to-b from-slate-900 to-indigo-950 font-sans text-gray-100 overflow-hidden select-none touch-manipulation flex flex-col">
      
      {/* Header / HUD */}
      <header className="bg-black/40 backdrop-blur-md px-2 py-1 flex justify-between items-center border-b border-white/10 shrink-0 h-12 relative z-20">
        
        {/* Left: Player Info & Combo */}
        <div className="flex items-center gap-2">
           <div className="relative">
             <div className="bg-indigo-600 p-1.5 rounded-lg shadow-lg border border-indigo-400">
               <Trophy size={14} className="text-yellow-300" />
             </div>
             {combo > 1 && (
               <div className="absolute -bottom-4 left-0 bg-yellow-500 text-black text-[9px] font-black px-1.5 rounded-full animate-bounce whitespace-nowrap shadow-lg border border-white z-50">
                 {combo} COMBO
               </div>
             )}
           </div>
           <div>
             <div className="text-[8px] text-gray-400 uppercase tracking-wider font-bold">You</div>
             <div className="font-black text-base leading-none font-mono tabular-nums">{myScore}</div>
           </div>
        </div>

        {/* Center: Timer & Status */}
        <div className="flex flex-col items-center absolute left-1/2 -translate-x-1/2 top-1">
            {gameState === 'playing' ? (
                <>
                  <div className={`flex items-center gap-1 font-mono text-base font-bold ${timeLeft < 30 ? 'text-red-400 animate-pulse' : 'text-white'}`}>
                    <Clock size={12} />
                    {formatTime(timeLeft)}
                  </div>
                  
                  {/* Attack Gauge */}
                  <div className="flex gap-0.5 mt-0.5">
                     {[...Array(ATTACK_THRESHOLD)].map((_, i) => (
                         <div key={i} className={`w-2 h-2 rounded-sm border border-black/50 transition-all duration-300 ${i < attackCharge ? 'bg-gradient-to-tr from-red-600 to-orange-400 shadow-[0_0_8px_rgba(239,68,68,0.8)] scale-110' : 'bg-gray-800'}`} />
                     ))}
                  </div>

                  {/* Combo Bar */}
                  {combo > 0 && (
                     <div className="w-12 h-0.5 bg-gray-800 rounded-full mt-1 overflow-hidden">
                        <div 
                          className="h-full bg-yellow-400 transition-all duration-100 ease-linear"
                          style={{ width: `${comboTimer}%` }}
                        />
                     </div>
                  )}
                </>
            ) : (
                <div className="text-[10px] font-bold text-indigo-300 tracking-[0.2em] mt-2">DUALITAIRE</div>
            )}
        </div>

        {/* Right: Opponent Info */}
        <div className="flex items-center gap-2 text-right">
           <div>
             <div className="text-[8px] text-gray-400 uppercase tracking-wider font-bold">Rival</div>
             <div className="font-black text-base leading-none font-mono tabular-nums text-gray-300">
               {roomData ? (roomData.host === user.uid ? roomData.guestScore || 0 : roomData.hostScore || 0) : 0}
             </div>
           </div>
           <div className="bg-slate-800 p-1.5 rounded-lg shadow-lg border border-slate-600">
             <Users size={14} className="text-red-400" />
           </div>
        </div>
      </header>

      {/* Main Game Area */}
      <main className="flex-1 p-1 max-w-lg mx-auto w-full flex flex-col relative z-10 overflow-hidden">
        
        {gameState === 'lobby' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 animate-in fade-in zoom-in duration-500 w-full">
            <div className="text-center">
                <h1 className="text-4xl sm:text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-300 to-purple-400 drop-shadow-[0_4px_4px_rgba(0,0,0,0.5)] tracking-tighter mb-1">
                DUALITAIRE
                </h1>
                <p className="text-indigo-200 text-xs tracking-widest uppercase opacity-80">Competitive Solitaire</p>
            </div>
            
            <div className="bg-black/20 backdrop-blur-sm p-4 sm:p-6 rounded-2xl border border-white/5 space-y-4 w-full max-w-[300px] sm:max-w-xs box-border">
               <button 
                onClick={createRoom}
                className="w-full flex items-center justify-center gap-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3.5 px-6 rounded-xl shadow-[0_4px_0_rgb(55,48,163)] active:shadow-none active:translate-y-[4px] transition-all"
              >
                <Play size={18} /> CREATE ROOM
              </button>
              
              <div className="flex gap-2 w-full">
                  <input 
                    type="text" 
                    placeholder="ID"
                    className="flex-1 min-w-0 bg-black/40 border-2 border-white/10 rounded-xl px-3 text-white placeholder-white/20 outline-none focus:border-indigo-400 transition-colors uppercase text-center font-mono tracking-widest"
                    id="roomInput"
                  />
                  <button 
                    onClick={() => {
                        const val = document.getElementById('roomInput').value.toUpperCase();
                        if(val) joinRoom(val);
                    }}
                    className="shrink-0 bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 px-4 rounded-xl shadow-[0_4px_0_rgb(51,65,85)] active:shadow-none active:translate-y-[4px] transition-all"
                  >
                    JOIN
                  </button>
              </div>
            </div>
          </div>
        )}

        {gameState === 'waiting' && (
           <div className="flex-1 flex flex-col items-center justify-center text-center animate-in pulse duration-1000">
             <div className="relative">
                 <div className="absolute inset-0 bg-indigo-500 blur-3xl opacity-20 rounded-full"></div>
                 <div className="text-5xl mb-4 relative">⚔️</div>
             </div>
             <h2 className="text-xl font-bold mb-2 text-white">WAITING...</h2>
             <div className="flex items-center gap-2 bg-black/40 px-4 py-2 rounded-full border border-white/10 mt-2">
                 <span className="text-gray-400 text-xs">ROOM ID:</span>
                 <span className="text-indigo-300 font-mono text-xl font-bold tracking-widest select-all">{roomId}</span>
             </div>
           </div>
        )}

        {gameState === 'playing' && (
          <div className="flex-1 flex flex-col gap-2 relative h-full">
            
            {/* Top Row: Waste, Stock, Foundation */}
            {/* Grid layout with fixed aspect ratio cards */}
            <div className="grid grid-cols-7 gap-1 px-1">
              
              {/* Stock */}
              <div onClick={handleStockClick} className="col-span-1 relative group cursor-pointer">
                   {deck.length > 0 ? (
                       <div className="w-full aspect-[5/7] bg-indigo-900 border-2 border-indigo-300/50 rounded-md shadow-sm group-active:scale-95 transition-transform">
                           <div className="absolute inset-1 border border-indigo-950/30 rounded-sm bg-gradient-to-br from-indigo-800 to-indigo-950"></div>
                           <div className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] w-4 h-4 flex items-center justify-center rounded-full font-bold shadow-md border border-white/20">
                               {deck.length}
                           </div>
                       </div>
                   ) : (
                       <div className="w-full aspect-[5/7] border-2 border-white/10 rounded-md flex items-center justify-center bg-black/20">
                           <RefreshCw size={14} className="text-white/30" />
                       </div>
                   )}
              </div>

              {/* Waste */}
              <div className="col-span-1 relative">
                   {waste.length > 0 ? (
                       <Card 
                         card={waste[waste.length - 1]} 
                         isSelected={selectedCard?.pileType === 'waste'}
                         onClick={() => handleCardClick('waste', 0, waste.length-1, waste[waste.length-1])}
                       />
                   ) : (
                       <div className="w-full aspect-[5/7] border-2 border-dashed border-white/5 rounded-md" />
                   )}
              </div>
              
              {/* Spacer */}
              <div className="col-span-1"></div>

              {/* Foundations */}
              {foundation.map((pile, idx) => (
                  <div 
                    key={`foundation-${idx}`}
                    className="col-span-1 border-2 border-white/10 bg-black/20 rounded-md flex items-center justify-center relative shadow-inner aspect-[5/7]"
                    onClick={() => handleCardClick('foundation', idx, null, null)}
                  >
                    {pile.length === 0 ? (
                        <div className="text-white/10 text-xl font-serif">A</div>
                    ) : (
                        <Card 
                          card={pile[pile.length - 1]} 
                          onClick={() => handleCardClick('foundation', idx, pile.length - 1, pile[pile.length - 1])}
                        />
                    )}
                  </div>
              ))}
            </div>

            {/* Tableau */}
            <div className="flex-1 grid grid-cols-7 gap-1 mt-1 pb-14 px-1 overflow-hidden">
              {tableau.map((pile, colIdx) => (
                <div key={`col-${colIdx}`} className="relative h-full">
                   {/* Clickable Area Background */}
                   <div 
                     className={`absolute inset-0 rounded-md transition-colors duration-300
                        ${frozenColumns[colIdx] ? 'bg-blue-500/20 ring-1 ring-blue-400' : 'hover:bg-white/5'}
                     `}
                     onClick={() => pile.length === 0 && handleCardClick('tableau', colIdx, 0, null)}
                   >
                       {frozenColumns[colIdx] && (
                           <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-50">
                               <Snowflake className="text-blue-300 animate-spin-slow drop-shadow-lg" size={20} />
                           </div>
                       )}

                       {pile.length === 0 && <div className="w-full aspect-[5/7] border border-white/5 rounded-md opacity-30" />}
                       
                       {pile.map((card, cardIdx) => {
                         // Adjusted Stacking: 0.4rem for back, 1.8rem for front to ensure new design visibility
                         let accumulatedTop = 0;
                         for(let i=0; i<cardIdx; i++) {
                             accumulatedTop += pile[i].faceUp ? 1.8 : 0.4;
                         }

                         return (
                           <div 
                             key={card.id} 
                             className="absolute w-full transition-all duration-300 ease-out"
                             style={{ 
                                 top: `${accumulatedTop}rem`, 
                                 zIndex: cardIdx 
                             }}
                           >
                             <Card 
                               card={card}
                               isFrozen={!!frozenColumns[colIdx]}
                               isSelected={selectedCard?.card.id === card.id}
                               onClick={(e) => {
                                   e.stopPropagation();
                                   handleCardClick('tableau', colIdx, cardIdx, card);
                               }}
                             />
                           </div>
                         );
                       })}
                   </div>
                </div>
              ))}
            </div>

            {/* Footer Action */}
             <div className="absolute bottom-2 left-0 right-0 flex justify-center z-20 pointer-events-none">
                <button 
                    onClick={handleGiveUp}
                    className="pointer-events-auto flex items-center gap-2 px-5 py-2 bg-red-950/80 hover:bg-red-900 text-red-200 rounded-full text-xs font-bold transition-all border border-red-800 shadow-lg backdrop-blur"
                >
                    <Flag size={12} /> GIVE UP
                </button>
            </div>

            {/* Effects */}
            {frozenColumns && Object.keys(frozenColumns).length > 0 && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-50 animate-in zoom-in duration-300">
                    <div className="bg-blue-600 text-white px-6 py-3 rounded-full font-black text-xl shadow-2xl transform -rotate-6 border-4 border-blue-200 flex items-center gap-2">
                        <Snowflake className="animate-spin" /> FROZEN!
                    </div>
                </div>
            )}
            
          </div>
        )}

        {gameState === 'finished' && (
            <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-500">
                <div className="bg-gradient-to-b from-slate-800 to-slate-900 text-white p-1 rounded-3xl max-w-sm w-full shadow-2xl border border-white/10">
                    <div className="bg-black/40 p-6 rounded-[20px] text-center">
                        <h2 className="text-4xl font-black mb-2 uppercase italic tracking-tighter drop-shadow-xl">
                            {roomData?.winner === 'draw' ? (
                                <span className="text-gray-400">DRAW</span>
                            ) : roomData?.winner === user.uid ? (
                                <span className="text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 to-yellow-600">VICTORY</span>
                            ) : (
                                <span className="text-gray-500">DEFEAT</span>
                            )}
                        </h2>
                        
                        <div className="py-6 space-y-3">
                            <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                                <span className="text-gray-400 font-bold text-xs">YOU</span>
                                <span className="font-mono text-2xl font-bold">{myScore}</span>
                            </div>
                            <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                                <span className="text-gray-400 font-bold text-xs">RIVAL</span>
                                <span className="font-mono text-2xl font-bold text-gray-500">
                                    {roomData.host === user.uid ? roomData.guestScore : roomData.hostScore}
                                </span>
                            </div>
                        </div>

                        <button 
                            onClick={() => window.location.reload()}
                            className="w-full bg-white text-black py-3 rounded-xl font-black text-lg shadow-lg hover:scale-105 transition-transform active:scale-95"
                        >
                            PLAY AGAIN
                        </button>
                    </div>
                </div>
            </div>
        )}
      </main>
    </div>
  );
}


