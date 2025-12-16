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
import { AlertCircle, Play, Users, Trophy, Snowflake, RefreshCw, Hand, Shield, Flag } from 'lucide-react';

// --- Configuration Helper ---

// 環境に応じて設定を取得する関数 (Vite対応版)
const getFirebaseConfig = () => {
  // Canvas環境 (プレビュー用)
  if (typeof __firebase_config !== 'undefined') {
    return JSON.parse(__firebase_config);
  }
  
  // ローカル開発環境 (Vite)
  // Viteでは import.meta.env.VITE_... を使用します
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

// --- Game Constants & Utilities ---
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const ATTACK_THRESHOLD = 2; // 2枚組札に置くと攻撃発生

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

const Card = ({ card, onClick, isSelected, isFrozen }) => {
  if (!card) return <div className="w-10 h-14 sm:w-12 sm:h-16 border-2 border-dashed border-white/20 rounded bg-transparent" />;

  if (!card.faceUp) {
    return (
      <div 
        onClick={onClick}
        className="w-10 h-14 sm:w-12 sm:h-16 bg-indigo-900 border-2 border-white rounded shadow-md cursor-pointer hover:mt-[-2px] transition-all relative"
      >
        <div className="absolute inset-1 border border-indigo-700 opacity-50 rounded-sm"></div>
      </div>
    );
  }

  return (
    <div 
      onClick={onClick}
      className={`
        w-10 h-14 sm:w-12 sm:h-16 bg-white rounded shadow-md cursor-pointer select-none flex flex-col items-center justify-center relative transition-all
        ${isSelected ? 'ring-4 ring-yellow-400 translate-y-[-4px]' : 'hover:translate-y-[-2px]'}
        ${isFrozen ? 'after:content-[""] after:absolute after:inset-0 after:bg-blue-400/50 after:backdrop-blur-[1px] after:rounded' : ''}
      `}
    >
      <div className={`text-xs sm:text-sm font-bold ${card.color === 'red' ? 'text-red-600' : 'text-gray-900'}`}>
        {card.suit}
      </div>
      <div className={`text-sm sm:text-base font-bold ${card.color === 'red' ? 'text-red-600' : 'text-gray-900'}`}>
        {card.rank}
      </div>
      {isFrozen && <Snowflake className="absolute text-blue-600 w-6 h-6 animate-pulse" />}
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
  const [selectedCard, setSelectedCard] = useState(null); // { pileType, pileIndex, cardIndex, card }
  const [frozenColumns, setFrozenColumns] = useState({}); // { colIndex: timestamp }
  const [attackCharge, setAttackCharge] = useState(0); // 0 to ATTACK_THRESHOLD
  const [myScore, setMyScore] = useState(0);
  
  // Effects
  const [lastAttackId, setLastAttackId] = useState(null);

  // Auth Setup
  useEffect(() => {
    const initAuth = async () => {
      // Check for Canvas specific auth token first
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        await signInWithCustomToken(auth, __initial_auth_token);
      } else {
        // Fallback for local development or when no custom token is provided
        await signInAnonymously(auth);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // Room Listener
  useEffect(() => {
    if (!user || !roomId) return;

    // Use 'rooms' subcollection to ensure valid path depth
    const unsub = onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), (docSnapshot) => {
      if (docSnapshot.exists()) {
        const data = docSnapshot.data();
        setRoomData(data);
        
        // Handle Game Start
        if (data.status === 'playing' && gameState === 'waiting') {
          startGameLocal();
          setGameState('playing');
        }

        // Handle Game Over
        if (data.status === 'finished' && gameState === 'playing') {
          setGameState('finished');
        }

        // Handle Attacks
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

  // --- Game Mechanics ---

  const startGameLocal = () => {
    const newDeck = createDeck();
    const newTableau = Array(7).fill().map(() => []);
    
    // Deal cards to tableau
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
  };

  const triggerFreezeEffect = () => {
    // Freeze 1 random column that has cards
    const availableCols = tableau.map((col, idx) => col.length > 0 ? idx : -1).filter(idx => idx !== -1);
    if (availableCols.length === 0) return;

    const targetCol = availableCols[Math.floor(Math.random() * availableCols.length)];
    
    setFrozenColumns(prev => ({
      ...prev,
      [targetCol]: Date.now() + 5000 // 5 seconds freeze
    }));

    // Auto unfreeze
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

  const updateScore = async (points) => {
    const newScore = myScore + points;
    setMyScore(newScore);
    
    // Sync score to Firestore periodically or on significant change
    // For this demo, we sync on every foundation move for responsiveness
    if (!roomData) return;
    const field = roomData.host === user.uid ? 'hostScore' : 'guestScore';
    
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
      [field]: newScore
    });

    // Check Win Condition (Simple: Score > 500 or Empty Deck)
    if (newScore > 5000) { // Arbitrary high number, usually means game done
         await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
            status: 'finished',
            winner: user.uid
        });
    }
  };

  const handleGiveUp = async () => {
    if (!window.confirm('本当に降参しますか？\n（対戦相手の勝利になります）')) return;
    if (!roomData) return;

    const opponentId = roomData.host === user.uid ? roomData.guest : roomData.host;
    
    // If opponent is not there yet or issue, just reset
    if (!opponentId) {
        setGameState('lobby');
        setRoomId('');
        return;
    }

    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
        status: 'finished',
        winner: opponentId // Set opponent as winner
    });
  };

  // --- Interaction Logic ---

  const handleStockClick = () => {
    if (deck.length === 0) {
      // Recycle waste
      if (waste.length === 0) return;
      const newDeck = [...waste].reverse().map(c => ({...c, faceUp: false}));
      setDeck(newDeck);
      setWaste([]);
    } else {
      // Draw card
      const card = deck[0];
      const newDeck = deck.slice(1);
      const newWaste = [...waste, {...card, faceUp: true}];
      setDeck(newDeck);
      setWaste(newWaste);
    }
    setSelectedCard(null);
  };

  const handleCardClick = (pileType, pileIndex, cardIndex, card) => {
    // Prevent interaction with frozen columns
    if (pileType === 'tableau' && frozenColumns[pileIndex]) return;

    // 1. Select Source
    if (!selectedCard) {
      if (!card) return; // Empty spot
      if (pileType === 'tableau' && !card.faceUp) {
          // Attempt to flip if it's the top card
          if (cardIndex === tableau[pileIndex].length - 1) {
              const newTableau = [...tableau];
              newTableau[pileIndex][cardIndex].faceUp = true;
              setTableau(newTableau);
              updateScore(5);
          }
          return;
      }
      if (pileType === 'foundation') return; // Can't move FROM foundation in this simple version
      
      setSelectedCard({ pileType, pileIndex, cardIndex, card });
      return;
    }

    // 2. Select Destination (Move Logic)
    const source = selectedCard;
    
    // Cancel selection if clicking same card
    if (source.card.id === card?.id) {
      setSelectedCard(null);
      return;
    }

    // A. Move to Foundation
    if (pileType === 'foundation') {
      if (isValidFoundationMove(source.card, pileIndex)) {
        executeMove(source, { pileType, pileIndex });
        
        // Attack Logic
        const newCharge = attackCharge + 1;
        if (newCharge >= ATTACK_THRESHOLD) {
          sendAttack();
          setAttackCharge(0);
        } else {
          setAttackCharge(newCharge);
        }
        updateScore(100); // Big points for foundation
      } else {
        setSelectedCard(null);
      }
      return;
    }

    // B. Move to Tableau
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
    
    // Remove from source
    if (source.pileType === 'waste') {
      cardsToMove = [waste[waste.length - 1]];
      setWaste(prev => prev.slice(0, -1));
    } else if (source.pileType === 'tableau') {
      const sourceCol = tableau[source.pileIndex];
      cardsToMove = sourceCol.slice(source.cardIndex);
      const newSourceCol = sourceCol.slice(0, source.cardIndex);
      // Don't auto-flip here, require click to flip for mechanic weight
      setTableau(prev => {
        const newT = [...prev];
        newT[source.pileIndex] = newSourceCol;
        return newT;
      });
    }

    // Add to destination
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

  // --- UI Helpers ---

  const createRoom = async () => {
    const newRoomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    // Corrected Path: artifacts/appId/public/data/rooms/roomId
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
    // Simplified: assuming room exists and is open
    await updateDoc(roomRef, {
      guest: user.uid,
      status: 'playing' // Auto start
    });
    setRoomId(inputRoomId);
    setGameState('playing');
    startGameLocal();
  };

  // --- Render ---

  if (!user) return <div className="flex items-center justify-center h-screen bg-indigo-900 text-white">Loading Auth...</div>;

  return (
    <div className="min-h-screen bg-gradient-to-b from-green-800 to-green-900 font-sans text-gray-100 overflow-hidden select-none touch-manipulation">
      
      {/* Header / HUD */}
      <header className="bg-black/30 backdrop-blur-md p-2 flex justify-between items-center border-b border-white/10 h-14 sm:h-16">
        <div className="flex items-center gap-2">
           <div className="bg-indigo-600 p-1.5 rounded-lg shadow-lg">
             <Trophy size={18} className="text-yellow-300" />
           </div>
           <div>
             <div className="text-[10px] text-gray-300 uppercase tracking-wider">You</div>
             <div className="font-bold text-lg leading-none">{myScore}</div>
           </div>
        </div>

        <div className="flex flex-col items-center">
            {gameState === 'playing' && (
                <div className="flex gap-1 mb-1">
                   {[...Array(ATTACK_THRESHOLD)].map((_, i) => (
                       <div key={i} className={`w-3 h-3 rounded-full border border-black/50 ${i < attackCharge ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]' : 'bg-gray-800'}`} />
                   ))}
                </div>
            )}
            <div className="text-xs font-bold text-yellow-400 tracking-widest">DUALITAIRE</div>
        </div>

        <div className="flex items-center gap-2 text-right">
           <div>
             <div className="text-[10px] text-gray-300 uppercase tracking-wider">Opponent</div>
             <div className="font-bold text-lg leading-none">
               {roomData ? (roomData.host === user.uid ? roomData.guestScore || 0 : roomData.hostScore || 0) : 0}
             </div>
           </div>
           <div className="bg-red-900 p-1.5 rounded-lg shadow-lg">
             <Users size={18} className="text-red-300" />
           </div>
        </div>
      </header>

      {/* Main Game Area */}
      <main className="p-2 sm:p-4 max-w-4xl mx-auto h-[calc(100vh-64px)] flex flex-col">
        
        {gameState === 'lobby' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 animate-in fade-in zoom-in duration-300">
            <h1 className="text-4xl sm:text-6xl font-black text-white drop-shadow-[0_4px_4px_rgba(0,0,0,0.5)] text-center tracking-tight">
              DUALITAIRE
            </h1>
            <p className="text-green-200 max-w-xs text-center text-sm">
               組札を揃えて相手におじゃま攻撃！<br/>先にクリアするか、スコアが高い方が勝利。
            </p>

            <div className="flex flex-col gap-4 w-full max-w-xs">
              <button 
                onClick={createRoom}
                className="flex items-center justify-center gap-2 bg-yellow-500 hover:bg-yellow-400 text-black font-bold py-4 px-6 rounded-xl shadow-[0_4px_0_rgb(161,98,7)] active:shadow-none active:translate-y-[4px] transition-all"
              >
                <Play size={20} /> 部屋を作成
              </button>
              
              <div className="flex gap-2">
                  <input 
                    type="text" 
                    placeholder="部屋IDを入力"
                    className="flex-1 bg-black/40 border-2 border-white/20 rounded-xl px-4 text-white placeholder-white/30 outline-none focus:border-yellow-400 transition-colors uppercase text-center"
                    id="roomInput"
                  />
                  <button 
                    onClick={() => {
                        const val = document.getElementById('roomInput').value.toUpperCase();
                        if(val) joinRoom(val);
                    }}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 px-6 rounded-xl shadow-[0_4px_0_rgb(55,48,163)] active:shadow-none active:translate-y-[4px] transition-all"
                  >
                    参加
                  </button>
              </div>
            </div>
          </div>
        )}

        {gameState === 'waiting' && (
           <div className="flex-1 flex flex-col items-center justify-center text-center animate-in pulse duration-1000">
             <div className="text-6xl mb-4">⏳</div>
             <h2 className="text-2xl font-bold mb-2">対戦相手を待っています...</h2>
             <p className="text-green-300 bg-black/30 px-4 py-2 rounded-lg font-mono text-xl select-all">Room ID: {roomId}</p>
             <p className="mt-4 text-sm opacity-70">相手にIDを教えて参加してもらってください</p>
           </div>
        )}

        {gameState === 'playing' && (
          <div className="flex-1 flex flex-col gap-4 relative">
            
            {/* Top Section: Stock/Waste & Foundation */}
            <div className="flex justify-between items-start">
              
              {/* Stock & Waste */}
              <div className="flex gap-3">
                <div onClick={handleStockClick} className="cursor-pointer relative group">
                   {deck.length > 0 ? (
                       <div className="w-10 h-14 sm:w-12 sm:h-16 bg-indigo-900 border-2 border-white rounded shadow-lg group-active:translate-y-1">
                           <div className="absolute inset-2 border border-indigo-700/50 rounded-sm"></div>
                           <div className="absolute -top-2 -right-2 bg-red-600 text-white text-[10px] w-5 h-5 flex items-center justify-center rounded-full font-bold shadow">
                               {deck.length}
                           </div>
                       </div>
                   ) : (
                       <div className="w-10 h-14 sm:w-12 sm:h-16 border-2 border-white/20 rounded flex items-center justify-center">
                           <RefreshCw size={16} className="text-white/30" />
                       </div>
                   )}
                </div>

                <div className="relative">
                   {waste.length > 0 ? (
                       <Card 
                         card={waste[waste.length - 1]} 
                         isSelected={selectedCard?.pileType === 'waste'}
                         onClick={() => handleCardClick('waste', 0, waste.length-1, waste[waste.length-1])}
                       />
                   ) : (
                       <div className="w-10 h-14 sm:w-12 sm:h-16" />
                   )}
                </div>
              </div>

              {/* Foundations */}
              <div className="flex gap-2 sm:gap-3">
                {foundation.map((pile, idx) => (
                  <div 
                    key={`foundation-${idx}`}
                    className="w-10 h-14 sm:w-12 sm:h-16 border-2 border-white/20 bg-black/10 rounded flex items-center justify-center relative"
                    onClick={() => handleCardClick('foundation', idx, null, null)}
                  >
                    {pile.length === 0 ? (
                        <span className="text-2xl text-white/10 font-serif">A</span>
                    ) : (
                        <Card 
                          card={pile[pile.length - 1]} 
                          onClick={() => handleCardClick('foundation', idx, pile.length - 1, pile[pile.length - 1])}
                        />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Tableau */}
            <div className="flex justify-between mt-2 h-full overflow-y-auto pb-4">
              {tableau.map((pile, colIdx) => (
                <div key={`col-${colIdx}`} className="flex flex-col items-center flex-1 min-w-[3rem]">
                   <div 
                     className={`relative w-full flex flex-col items-center min-h-[100px] transition-colors rounded-lg ${frozenColumns[colIdx] ? 'bg-blue-500/20 ring-2 ring-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.5)]' : ''}`}
                     onClick={() => pile.length === 0 && handleCardClick('tableau', colIdx, 0, null)}
                   >
                       {frozenColumns[colIdx] && (
                           <div className="absolute -top-6 left-1/2 -translate-x-1/2 z-50 text-blue-300 font-bold text-xs animate-bounce whitespace-nowrap drop-shadow-md">
                               FROZEN!
                           </div>
                       )}

                       {pile.length === 0 && <div className="w-10 h-14 sm:w-12 sm:h-16 border border-white/10 rounded m-1 opacity-50" />}
                       
                       {pile.map((card, cardIdx) => (
                         <div 
                           key={card.id} 
                           className="absolute transition-all"
                           style={{ top: `${cardIdx * (card.faceUp ? 1.5 : 0.5)}rem`, zIndex: cardIdx }}
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
                       ))}
                   </div>
                </div>
              ))}
            </div>

            {/* Footer Action: Give Up */}
             <div className="mt-auto pb-4 flex justify-center z-10">
                <button 
                    onClick={handleGiveUp}
                    className="flex items-center gap-2 px-4 py-2 bg-red-900/50 hover:bg-red-900 text-red-200 rounded-lg text-sm transition-colors border border-red-800"
                >
                    <Flag size={14} /> 降参する
                </button>
            </div>

            {/* Floating Attack Notification */}
            {frozenColumns && Object.keys(frozenColumns).length > 0 && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-50">
                    <div className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></div>
                    <div className="bg-blue-600 text-white px-6 py-2 rounded-full font-black text-xl shadow-xl transform rotate-[-5deg] border-4 border-white">
                        おじゃま氷!
                    </div>
                </div>
            )}
            
          </div>
        )}

        {gameState === 'finished' && (
            <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur flex items-center justify-center p-4">
                <div className="bg-white text-gray-900 p-8 rounded-2xl max-w-sm w-full text-center shadow-2xl animate-in zoom-in duration-300">
                    <h2 className="text-4xl font-black mb-4 uppercase italic">
                        {roomData?.winner === user.uid ? (
                            <span className="text-yellow-500 drop-shadow-md">WINNER!</span>
                        ) : (
                            <span className="text-gray-500">DEFEAT...</span>
                        )}
                    </h2>
                    
                    <div className="space-y-2 mb-6 text-lg">
                        <div className="flex justify-between border-b py-1">
                            <span>You</span>
                            <span className="font-bold">{myScore}</span>
                        </div>
                        <div className="flex justify-between border-b py-1">
                            <span>Opponent</span>
                            <span className="font-bold">
                                {roomData.host === user.uid ? roomData.guestScore : roomData.hostScore}
                            </span>
                        </div>
                    </div>

                    <button 
                        onClick={() => window.location.reload()}
                        className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow-lg hover:bg-indigo-500 transition-colors"
                    >
                        タイトルへ戻る
                    </button>
                </div>
            </div>
        )}
      </main>
    </div>
  );
}

