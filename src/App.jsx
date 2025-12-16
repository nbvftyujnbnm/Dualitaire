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
  initializeFirestore,
  memoryLocalCache,
  collection, 
  doc, 
  setDoc, 
  onSnapshot, 
  updateDoc, 
  arrayUnion,
  increment,
  serverTimestamp,
  runTransaction
} from 'firebase/firestore';
import { AlertCircle, Play, Users, Trophy, Snowflake, RefreshCw, Hand, Shield, Flag, Clock, Zap, Swords, Eye, Crown, User } from 'lucide-react';

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

// FIX: Firestoreの接続エラー回避のためメモリキャッシュを使用
const db = initializeFirestore(app, {
  localCache: memoryLocalCache()
});

const appId = getAppId();

// --- Game Constants ---
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const ATTACK_THRESHOLD = 2; 
const GAME_DURATION_SEC = 180; 
const COMBO_WINDOW_MS = 3000; 
const MAX_ROUNDS = 3;

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
  if (!card) return (
    <div className="w-full aspect-[5/7] border-2 border-dashed border-white/10 rounded-md bg-white/5 box-border" />
  );

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
      <div className={`absolute top-[4%] left-[8%] font-bold leading-none text-[clamp(10px,3vw,18px)] tracking-tighter ${card.color === 'red' ? 'text-red-600' : 'text-gray-900'}`}>
        {card.rank}
      </div>
      <div className={`absolute top-[4%] right-[8%] leading-none text-[clamp(10px,2.5vw,16px)] ${card.color === 'red' ? 'text-red-600' : 'text-gray-900'}`}>
        {card.suit}
      </div>
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
  const [gameState, setGameState] = useState('lobby'); // lobby, room_lobby, count_down, playing, intermission, finished
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
  
  // 3-Round System & Start Countdown
  const [countDown, setCountDown] = useState(null);
  
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

  // Room Listener
  useEffect(() => {
    if (!user || !roomId) return;

    const unsub = onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), (docSnapshot) => {
      if (docSnapshot.exists()) {
        const data = docSnapshot.data();
        setRoomData(data);
        
        // --- State Transitions ---
        // 外部（Firestore）の状態変化に合わせてローカルのgameStateを変更

        // 1. ロビー待機
        if (data.status === 'waiting' && gameState !== 'room_lobby') {
            setGameState('room_lobby');
        }

        // 2. カウントダウン開始
        if (data.status === 'count_down' && gameState !== 'count_down' && gameState !== 'playing') {
            startCountDownSequence();
        }

        // 3. ゲーム中 (途中参加やリロード時の復帰用)
        if (data.status === 'playing' && (gameState === 'waiting' || gameState === 'intermission' || gameState === 'room_lobby' || gameState === 'lobby')) {
             setGameState('playing');
        }

        // 4. インターミッション（ラウンド終了）
        if (data.status === 'intermission' && gameState === 'playing') {
          setGameState('intermission');
          if (timerRef.current) clearInterval(timerRef.current);
        }

        // 5. 最終結果
        if (data.status === 'finished' && gameState !== 'finished') {
          setGameState('finished');
          if (timerRef.current) clearInterval(timerRef.current);
        }

        // 攻撃処理
        if (user && (data.host === user.uid || data.guest === user.uid)) {
            if (data.attacks && data.attacks.length > 0) {
                const latestAttack = data.attacks[data.attacks.length - 1];
                if (latestAttack.target === user.uid && latestAttack.id !== lastAttackId) {
                    triggerFreezeEffect();
                    setLastAttackId(latestAttack.id);
                }
            }
        }
      }
    }, (error) => {
        console.error("Firestore Snapshot Error:", error);
    });

    return () => unsub();
  }, [user, roomId, gameState, lastAttackId]);

  // --- 修正: ゲーム開始トリガー ---
  // gameStateが 'playing' になった瞬間にカードを配る（プレイヤーのみ）
  // useEffectを使うことで、状態遷移後に確実に実行されるようにする
  useEffect(() => {
      if (gameState === 'playing' && user && roomData) {
          const isHost = roomData.host === user.uid;
          const isGuest = roomData.guest === user.uid;
          
          if (isHost || isGuest) {
              // 既にカードがある場合はリセットしない（リロード対策が必要なら別途ロジックが必要だが、今回は簡易的に）
              if (deck.length === 0 && tableau.length === 0) {
                  startGameLocal();
              }
          }
      }
  }, [gameState, user, roomData]); // 依存配列に注意

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
          if (roomData.host === user.uid) handleTimeUp(); // Host triggers time-up
        }
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [gameState, roomData, user]);

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

  // --- Role Helpers ---
  const isHost = roomData?.host === user?.uid;
  const isGuest = roomData?.guest === user?.uid;
  const isPlayer = isHost || isGuest;
  const isSpectator = !isPlayer && roomData;

  // --- Game Control ---

  const startCountDownSequence = () => {
    setGameState('count_down');
    // Clear board for visual clarity
    setDeck([]); setTableau([]); setWaste([]); setFoundation([[],[],[],[]]);
    
    setCountDown(3);
    let count = 3;
    const interval = setInterval(() => {
      count--;
      setCountDown(count);
      if (count <= 0) {
        clearInterval(interval);
        setTimeout(() => {
            // ここでは gameState を変えるだけにする
            // 実際の startGameLocal は useEffect でトリガーされる
            setGameState('playing');
        }, 500);
      }
    }, 1000);
  };

  const startGameLocal = () => {
    console.log("Starting Local Game..."); // Debug
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

  const triggerStartGame = async () => {
      if (!isHost) return;
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
          status: 'count_down',
          startTime: serverTimestamp() 
      });
  };

  const handleTimeUp = async () => {
    if (!roomData || !isHost) return; 
    
    const hostTotal = (roomData.hostTotalScore || 0) + roomData.hostScore;
    const guestTotal = (roomData.guestTotalScore || 0) + roomData.guestScore;

    if (roomData.currentRound >= MAX_ROUNDS) {
        let winnerId = 'draw';
        if (hostTotal > guestTotal) winnerId = roomData.host;
        if (guestTotal > hostTotal) winnerId = roomData.guest;

        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
            status: 'finished',
            winner: winnerId,
            hostTotalScore: hostTotal, 
            guestTotalScore: guestTotal,
            hostScore: 0,
            guestScore: 0
        });
    } else {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
            status: 'intermission',
            hostTotalScore: hostTotal,
            guestTotalScore: guestTotal
        });
    }
  };

  const nextRound = async () => {
      if (!isHost) return;
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
          status: 'count_down',
          currentRound: increment(1),
          hostScore: 0,
          guestScore: 0,
          hostCharge: 0,
          guestCharge: 0,
          startTime: serverTimestamp()
      });
  };

  // --- Interaction Logic ---

  const handleStockClick = () => {
    if (!isPlayer) return;
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
    if (!isPlayer) return;
    if (pileType === 'tableau' && frozenColumns[pileIndex]) return;

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

    if (!selectedCard) {
      if (!card) return; 
      if (pileType === 'tableau' && !card.faceUp) return;
      if (pileType === 'foundation') return; 
      setSelectedCard({ pileType, pileIndex, cardIndex, card });
      return;
    }

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
    if (targetPile.length === 0) return card.rank === 'A';
    const topCard = targetPile[targetPile.length - 1];
    return card.suit === topCard.suit && card.value === topCard.value + 1;
  };

  const isValidTableauMove = (card, pileIndex) => {
    const targetPile = tableau[pileIndex];
    if (targetPile.length === 0) return card.rank === 'K';
    const topCard = targetPile[targetPile.length - 1];
    return card.color !== topCard.color && card.value === topCard.value - 1;
  };

  const executeMove = (source, dest) => {
    let cardsToMove = [];
    if (source.pileType === 'waste') {
      cardsToMove = [waste[waste.length - 1]];
      setWaste(prev => prev.slice(0, -1));
    } else if (source.pileType === 'tableau') {
      const sourceCol = tableau[source.pileIndex];
      cardsToMove = sourceCol.slice(source.cardIndex);
      const newSourceCol = sourceCol.slice(0, source.cardIndex);
      const lastIndex = newSourceCol.length - 1;
      if (lastIndex >= 0 && !newSourceCol[lastIndex].faceUp) {
          newSourceCol[lastIndex] = { ...newSourceCol[lastIndex], faceUp: true };
          setTimeout(() => updateScore(5), 0);
      }
      setTableau(prev => { const newT = [...prev]; newT[source.pileIndex] = newSourceCol; return newT; });
    }

    if (dest.pileType === 'foundation') {
      setFoundation(prev => { const newF = [...prev]; newF[dest.pileIndex] = [...newF[dest.pileIndex], cardsToMove[0]]; return newF; });
    } else if (dest.pileType === 'tableau') {
      setTableau(prev => { const newT = [...prev]; newT[dest.pileIndex] = [...newT[dest.pileIndex], ...cardsToMove]; return newT; });
    }
    setSelectedCard(null);
  };

  const updateScore = async (points, isFoundationMove = false) => {
    let multiplier = 1;
    let addedScore = points;
    let newCharge = attackCharge;

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
      newCharge = attackCharge + chargeAmount;
      if (newCharge >= ATTACK_THRESHOLD) {
        sendAttack();
        setAttackCharge(0);
        newCharge = 0;
      } else {
        setAttackCharge(newCharge);
      }
    }

    const newScore = myScore + addedScore;
    setMyScore(newScore);
    
    if (!roomData) return;
    const scoreField = isHost ? 'hostScore' : 'guestScore';
    const chargeField = isHost ? 'hostCharge' : 'guestCharge';

    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
      [scoreField]: newScore,
      [chargeField]: newCharge
    });
  };

  const triggerFreezeEffect = () => {
    const availableCols = tableau.map((col, idx) => col.length > 0 ? idx : -1).filter(idx => idx !== -1);
    if (availableCols.length === 0) return;
    const targetCol = availableCols[Math.floor(Math.random() * availableCols.length)];
    setFrozenColumns(prev => ({...prev, [targetCol]: Date.now() + 5000 }));
    setTimeout(() => {
      setFrozenColumns(prev => { const newState = { ...prev }; delete newState[targetCol]; return newState; });
    }, 5000);
  };

  const sendAttack = async () => {
    if (!roomData) return;
    const opponentId = roomData.host === user.uid ? roomData.guest : roomData.host;
    if (!opponentId) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${roomId}`), {
      attacks: arrayUnion({ id: crypto.randomUUID(), target: opponentId, type: 'freeze', timestamp: Date.now() })
    });
  };

  // --- Room Management ---

  const createRoom = async () => {
    const newRoomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${newRoomId}`), {
      host: user.uid,
      guest: null,
      status: 'waiting', 
      hostScore: 0, guestScore: 0,
      hostTotalScore: 0, guestTotalScore: 0,
      hostCharge: 0, guestCharge: 0,
      currentRound: 1,
      spectators: [],
      attacks: [],
      createdAt: serverTimestamp()
    });
    setRoomId(newRoomId);
    setGameState('room_lobby');
  };

  const joinRoom = async (inputRoomId) => {
    const roomRef = doc(db, 'artifacts', appId, 'public', 'data', 'rooms', `room_${inputRoomId}`);
    try {
        await runTransaction(db, async (transaction) => {
            const roomDoc = await transaction.get(roomRef);
            if (!roomDoc.exists()) throw "Room does not exist!";
            const data = roomDoc.data();

            if (!data.guest) {
                transaction.update(roomRef, { guest: user.uid });
            } else if (data.guest !== user.uid && data.host !== user.uid) {
                transaction.update(roomRef, { spectators: arrayUnion(user.uid) });
            }
        });
        setRoomId(inputRoomId);
        setGameState('room_lobby');
    } catch (e) {
        console.error("Join failed", e);
        alert("ルームに参加できませんでした。");
    }
  };

  const handleGiveUp = async () => {
    if (!isPlayer) return;
    if (!window.confirm('このラウンドを降参しますか？')) return;
    if (isHost) handleTimeUp(); 
    else {
        alert("ホストのみがラウンドを終了できます（機能制限）");
    }
  };

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-[100dvh] bg-gradient-to-b from-slate-900 to-indigo-950 font-sans text-gray-100 overflow-hidden select-none touch-manipulation flex flex-col">
      
      {/* Header */}
      <header className="bg-black/40 backdrop-blur-md px-2 py-1 flex justify-between items-center border-b border-white/10 shrink-0 h-12 relative z-20">
        {(gameState !== 'lobby' && gameState !== 'room_lobby') && (
        <>
            {/* Left: You */}
            <div className="flex items-center gap-2">
                <div className="relative">
                    <div className={`p-1.5 rounded-lg shadow-lg border ${isSpectator ? 'bg-gray-700 border-gray-500' : 'bg-indigo-600 border-indigo-400'}`}>
                        {isSpectator ? <Eye size={14} className="text-gray-300"/> : <Trophy size={14} className="text-yellow-300" />}
                    </div>
                    {!isSpectator && combo > 1 && (
                        <div className="absolute -bottom-4 left-0 bg-yellow-500 text-black text-[9px] font-black px-1.5 rounded-full animate-bounce whitespace-nowrap shadow-lg border border-white z-50">
                            {combo} COMBO
                        </div>
                    )}
                </div>
                <div>
                    <div className="text-[8px] text-gray-400 uppercase tracking-wider font-bold">
                        {isHost ? 'HOST (YOU)' : isSpectator ? 'HOST' : 'GUEST (YOU)'}
                    </div>
                    <div className="font-black text-base leading-none font-mono tabular-nums">
                        {isSpectator ? roomData?.hostScore || 0 : myScore}
                    </div>
                </div>
            </div>

            {/* Center: Status */}
            <div className="flex flex-col items-center absolute left-1/2 -translate-x-1/2 top-1">
                {gameState === 'playing' || gameState === 'count_down' ? (
                    <>
                        <div className="flex items-center gap-2">
                            <div className="bg-white/10 px-1.5 rounded text-[10px] font-bold text-indigo-200">R{roomData?.currentRound}</div>
                            <div className={`flex items-center gap-1 font-mono text-base font-bold ${timeLeft < 30 ? 'text-red-400 animate-pulse' : 'text-white'}`}>
                                <Clock size={12} />
                                {formatTime(timeLeft)}
                            </div>
                        </div>
                        <div className="flex gap-4 mt-1 opacity-50 text-[8px]">
                            {isSpectator && <span>WATCHING MATCH</span>}
                        </div>
                    </>
                ) : (
                    <div className="text-[10px] font-bold text-indigo-300 tracking-[0.2em] mt-2">DUALITAIRE</div>
                )}
            </div>

            {/* Right: Rival */}
            <div className="flex items-center gap-2 text-right">
                <div className="flex flex-col items-end">
                    <div className="text-[8px] text-gray-400 uppercase tracking-wider font-bold">
                        {isSpectator ? 'GUEST' : 'RIVAL'}
                    </div>
                    <div className="font-black text-base leading-none font-mono tabular-nums text-gray-300">
                        {isSpectator ? roomData?.guestScore || 0 : (isHost ? roomData?.guestScore : roomData?.hostScore) || 0}
                    </div>
                    <div className="flex gap-0.5 mt-0.5">
                        {[...Array(ATTACK_THRESHOLD)].map((_, i) => {
                            const chg = isSpectator ? roomData?.guestCharge : (isHost ? roomData?.guestCharge : roomData?.hostCharge);
                            return <div key={i} className={`w-1.5 h-1.5 rounded-full border border-black/30 ${i < (chg||0) ? 'bg-red-500' : 'bg-gray-700'}`} />
                        })}
                    </div>
                </div>
                <div className="bg-slate-800 p-1.5 rounded-lg shadow-lg border border-slate-600">
                    <Users size={14} className="text-red-400" />
                </div>
            </div>
        </>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 p-1 max-w-lg mx-auto w-full flex flex-col relative z-10 overflow-hidden">
        
        {gameState === 'count_down' && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="text-8xl font-black text-white animate-ping">
                    {countDown > 0 ? countDown : 'GO!'}
                </div>
            </div>
        )}

        {gameState === 'lobby' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 animate-in fade-in zoom-in duration-500 w-full">
            <div className="text-center">
                <h1 className="text-4xl sm:text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-300 to-purple-400 drop-shadow-[0_4px_4px_rgba(0,0,0,0.5)] tracking-tighter mb-1">
                DUALITAIRE
                </h1>
                <p className="text-indigo-200 text-xs tracking-widest uppercase opacity-80">Competitive Solitaire</p>
                <div className="mt-4 flex justify-center gap-2 text-[10px] text-gray-400 border border-white/10 rounded-full px-4 py-1 bg-black/20">
                    <span className="flex items-center gap-1"><Clock size={10}/> 3 MINS</span>
                    <span>•</span>
                    <span className="flex items-center gap-1"><Swords size={10}/> 3 ROUNDS</span>
                </div>
            </div>
            
            <div className="bg-black/20 backdrop-blur-sm p-4 sm:p-6 rounded-2xl border border-white/5 space-y-4 w-full max-w-[300px] sm:max-w-xs box-border">
               <button 
                onClick={createRoom}
                className="w-full flex items-center justify-center gap-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3.5 px-6 rounded-xl shadow-[0_4px_0_rgb(55,48,163)] active:shadow-none active:translate-y-[4px] transition-all"
              >
                <Play size={18} /> CREATE ROOM
              </button>
              <div className="flex gap-2 w-full">
                  <input type="text" placeholder="ID" className="flex-1 min-w-0 bg-black/40 border-2 border-white/10 rounded-xl px-3 text-white placeholder-white/20 outline-none focus:border-indigo-400 transition-colors uppercase text-center font-mono tracking-widest" id="roomInput"/>
                  <button onClick={() => { const val = document.getElementById('roomInput').value.toUpperCase(); if(val) joinRoom(val); }} className="shrink-0 bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 px-4 rounded-xl shadow-[0_4px_0_rgb(51,65,85)] active:shadow-none active:translate-y-[4px] transition-all">JOIN</button>
              </div>
            </div>
          </div>
        )}

        {gameState === 'room_lobby' && (
           <div className="flex-1 flex flex-col items-center justify-center p-4">
             <div className="w-full max-w-sm bg-slate-900/80 border border-white/10 rounded-2xl p-6 shadow-2xl backdrop-blur-md">
                <div className="flex justify-between items-center mb-6 border-b border-white/10 pb-4">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2"><Users size={20}/> ROOM LOBBY</h2>
                    <span className="font-mono text-indigo-400 font-bold bg-indigo-900/30 px-3 py-1 rounded select-all">{roomId}</span>
                </div>

                <div className="space-y-3 mb-8">
                    <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/5">
                        <div className="flex items-center gap-3">
                            <Crown size={18} className="text-yellow-500"/>
                            <div>
                                <div className="text-xs text-gray-400">HOST</div>
                                <div className="font-bold">{roomData?.host ? 'Player 1' : '...'}</div>
                            </div>
                        </div>
                        {isHost && <span className="text-[10px] bg-yellow-500/20 text-yellow-300 px-2 py-0.5 rounded">YOU</span>}
                    </div>

                    <div className={`flex items-center justify-between p-3 rounded-lg border ${roomData?.guest ? 'bg-white/5 border-white/5' : 'bg-black/20 border-dashed border-white/10'}`}>
                        <div className="flex items-center gap-3">
                            <Swords size={18} className={roomData?.guest ? "text-red-400" : "text-gray-600"}/>
                            <div>
                                <div className="text-xs text-gray-400">GUEST</div>
                                <div className={roomData?.guest ? "font-bold" : "text-gray-500 italic"}>
                                    {roomData?.guest ? 'Player 2' : 'Waiting...'}
                                </div>
                            </div>
                        </div>
                        {isGuest && <span className="text-[10px] bg-red-500/20 text-red-300 px-2 py-0.5 rounded">YOU</span>}
                    </div>

                    <div className="text-center pt-2">
                        <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                            <Eye size={12}/> SPECTATORS: {roomData?.spectators?.length || 0}
                        </div>
                        {isSpectator && <div className="text-xs text-indigo-400 mt-1">あなたは観戦モードです</div>}
                    </div>
                </div>

                {isHost ? (
                    <button 
                        onClick={triggerStartGame}
                        disabled={!roomData?.guest}
                        className={`w-full py-4 rounded-xl font-black text-lg shadow-lg transition-all flex items-center justify-center gap-2
                            ${roomData?.guest 
                                ? 'bg-indigo-600 text-white hover:scale-105 active:scale-95 cursor-pointer' 
                                : 'bg-gray-700 text-gray-500 cursor-not-allowed'}
                        `}
                    >
                        {roomData?.guest ? 'START GAME' : 'WAITING FOR GUEST...'}
                    </button>
                ) : (
                    <div className="text-center text-sm text-gray-400 animate-pulse">
                        Waiting for host to start...
                    </div>
                )}
             </div>
           </div>
        )}

        {(gameState === 'playing' || gameState === 'count_down') && (
          <div className="flex-1 flex flex-col gap-2 relative h-full">
            {isSpectator && (
                <div className="absolute inset-0 z-40 bg-black/60 backdrop-blur-[2px] flex flex-col items-center justify-center pointer-events-none">
                    <div className="bg-black/80 p-6 rounded-2xl border border-white/10 text-center">
                        <Eye size={48} className="mx-auto mb-4 text-indigo-400"/>
                        <h3 className="text-2xl font-bold text-white mb-2">SPECTATING</h3>
                        <p className="text-gray-400 text-sm">現在、試合を観戦中です。<br/>スコアボードで戦況を確認してください。</p>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-7 gap-1 px-1">
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
              <div className="col-span-1"></div>
              {foundation.map((pile, idx) => (
                  <div 
                    key={`foundation-${idx}`}
                    className="col-span-1 border-2 border-white/10 bg-black/20 rounded-md flex items-center justify-center relative shadow-inner aspect-[5/7]"
                    onClick={() => handleCardClick('foundation', idx, null, null)}
                  >
                    {pile.length === 0 ? <div className="text-white/10 text-xl font-serif">A</div> : <Card card={pile[pile.length - 1]} onClick={() => handleCardClick('foundation', idx, pile.length - 1, pile[pile.length - 1])} />}
                  </div>
              ))}
            </div>

            <div className="flex-1 grid grid-cols-7 gap-1 mt-1 pb-14 px-1 overflow-hidden">
              {tableau.map((pile, colIdx) => (
                <div key={`col-${colIdx}`} className="relative h-full">
                   <div 
                     className={`absolute inset-0 rounded-md transition-colors duration-300 ${frozenColumns[colIdx] ? 'bg-blue-500/20 ring-1 ring-blue-400' : 'hover:bg-white/5'}`}
                     onClick={() => pile.length === 0 && handleCardClick('tableau', colIdx, 0, null)}
                   >
                       {frozenColumns[colIdx] && <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-50"><Snowflake className="text-blue-300 animate-spin-slow drop-shadow-lg" size={20} /></div>}
                       {pile.length === 0 && <div className="w-full aspect-[5/7] border border-white/5 rounded-md opacity-30" />}
                       {pile.map((card, cardIdx) => {
                         let accumulatedTop = 0;
                         for(let i=0; i<cardIdx; i++) accumulatedTop += pile[i].faceUp ? 1.8 : 0.4;
                         return (
                           <div key={card.id} className="absolute w-full transition-all duration-300 ease-out" style={{ top: `${accumulatedTop}rem`, zIndex: cardIdx }}>
                             <Card card={card} isFrozen={!!frozenColumns[colIdx]} isSelected={selectedCard?.card.id === card.id} onClick={(e) => { e.stopPropagation(); handleCardClick('tableau', colIdx, cardIdx, card); }} />
                           </div>
                         );
                       })}
                   </div>
                </div>
              ))}
            </div>

             <div className="absolute bottom-2 left-0 right-0 flex justify-center z-20 pointer-events-none">
                {isPlayer && (
                <button 
                    onClick={handleGiveUp}
                    className="pointer-events-auto flex items-center gap-2 px-5 py-2 bg-red-950/80 hover:bg-red-900 text-red-200 rounded-full text-xs font-bold transition-all border border-red-800 shadow-lg backdrop-blur"
                >
                    <Flag size={12} /> GIVE UP
                </button>
                )}
            </div>

            {frozenColumns && Object.keys(frozenColumns).length > 0 && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-50 animate-in zoom-in duration-300">
                    <div className="bg-blue-600 text-white px-6 py-3 rounded-full font-black text-xl shadow-2xl transform -rotate-6 border-4 border-blue-200 flex items-center gap-2">
                        <Snowflake className="animate-spin" /> FROZEN!
                    </div>
                </div>
            )}
          </div>
        )}

        {(gameState === 'intermission' || gameState === 'finished') && (
            <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-500">
                <div className="bg-gradient-to-b from-slate-800 to-slate-900 text-white p-1 rounded-3xl max-w-sm w-full shadow-2xl border border-white/10">
                    <div className="bg-black/40 p-6 rounded-[20px] text-center">
                        <div className="mb-4">
                            <h2 className="text-3xl font-black uppercase italic tracking-tighter drop-shadow-xl text-indigo-300">
                                {gameState === 'finished' ? 'FINAL RESULT' : `ROUND ${roomData?.currentRound} OVER`}
                            </h2>
                        </div>

                        <div className="py-4 space-y-3">
                            <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                                <span className="text-gray-400 font-bold text-xs">HOST (Total)</span>
                                <span className="font-mono text-2xl font-bold">{roomData?.hostTotalScore || 0}</span>
                            </div>
                            <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                                <span className="text-gray-400 font-bold text-xs">GUEST (Total)</span>
                                <span className="font-mono text-2xl font-bold text-gray-500">{roomData?.guestTotalScore || 0}</span>
                            </div>
                        </div>

                        {gameState === 'finished' && (
                            <div className="my-6">
                                <div className="text-4xl font-black">
                                    {roomData?.winner === user.uid ? (
                                        <span className="text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 to-yellow-600 animate-pulse">VICTORY!</span>
                                    ) : roomData?.winner === 'draw' ? (
                                        <span className="text-gray-400">DRAW</span>
                                    ) : (
                                        <span className="text-gray-600">{isPlayer ? "DEFEAT..." : "GAME SET"}</span>
                                    )}
                                </div>
                            </div>
                        )}

                        {gameState === 'intermission' ? (
                            isHost ? (
                                <button onClick={nextRound} className="w-full bg-indigo-600 text-white py-3 rounded-xl font-black text-lg shadow-lg hover:scale-105 border-b-4 border-indigo-800">
                                    NEXT ROUND <Play size={16} className="inline ml-1 mb-1"/>
                                </button>
                            ) : (
                                <div className="text-sm text-gray-400 animate-pulse">Waiting for host...</div>
                            )
                        ) : (
                            <button onClick={() => window.location.reload()} className="w-full bg-white text-black py-3 rounded-xl font-black text-lg shadow-lg hover:scale-105">
                                TITLE SCREEN
                            </button>
                        )}
                    </div>
                </div>
            </div>
        )}
      </main>
    </div>
  );
}


