// test-31.js — fuzz the "31" engine: full multi-round matches with random legal
// play (incl. knocking), asserting termination, conservation, monotonic lives,
// and a single winner. Plus scoring unit checks. Run: node test-31.js
const { ThirtyOneGame, handScore } = require('./thirty_one');

function mulberry32(seed){ let a=seed>>>0; return function(){ a|=0;a=(a+0x6D2B79F5)|0; let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }
function assert(c,m,ctx){ if(!c){ console.error('ASSERT FAIL:',m,ctx?JSON.stringify(ctx):''); process.exit(1);} }
const card=(rank,suit)=>({rank,suit,id:rank+suit});

// ---- scoring unit checks ----
assert(handScore([card('A','S'),card('K','S'),card('Q','S')]).score===31,'AKQ same suit = 31');
assert(handScore([card('7','S'),card('7','H'),card('7','D')]).score===30.5,'trip 7s = 30.5');
assert(handScore([card('A','S'),card('A','H'),card('A','D')]).score===30.5,'trip aces = 30.5');
assert(handScore([card('10','H'),card('9','H'),card('2','S')]).score===19,'10H 9H = 19 hearts');
assert(handScore([card('A','S'),card('2','H'),card('3','D')]).score===11,'lone ace = 11');
assert(handScore([card('K','C'),card('Q','C'),card('A','S')]).score===20,'KQ clubs = 20');
console.log('OK — 31 scoring unit checks passed.');

const GAMES=3000;
let totalRounds=0, knocks=0, declared31=0, ties=0, totalMoves=0;

for(let g=0; g<GAMES; g++){
  const rng=mulberry32(g+1);
  const game=new ThirtyOneGame({rng});
  const n=2+Math.floor(rng()*5); // 2..6
  for(let i=0;i<n;i++) game.addPlayer({token:'p'+i,name:'P'+i});
  game.start();
  assert(game.cardCount()===52,'conservation after start',{g});

  const prevLives={}; game.players.forEach(p=>prevLives[p.id]=p.lives);
  let steps=0;
  while(game.phase==='playing'){
    if(++steps>200000) assert(false,'match did not terminate',{g});
    if(game.reveal){
      if(game.reveal.reason==='31') declared31++;
      if(game.reveal.winnerIds && game.reveal.winnerIds.length>1) ties++;
      totalRounds++;
      game.move(game.players[0].id,{type:'next_round'});
      continue;
    }
    const cur=game.currentPlayer();
    assert(cur && !cur.eliminated && cur.connected,'valid current player',{g});
    if(game.turnPhase==='draw'){
      if(!game.knockerId && game.activePlayers().length>=2 && rng()<0.22){ game.move(cur.id,{type:'knock'}); knocks++; }
      else { const from=(game.discard.length>0 && rng()<0.5)?'discard':'stock'; game.move(cur.id,{type:'draw',from}); }
    } else {
      const c=cur.hand[Math.floor(rng()*cur.hand.length)];
      game.move(cur.id,{type:'discard',cardId:c.id});
    }
    totalMoves++;
    // invariants
    assert(game.cardCount()===52,'conservation mid-match',{g,after:game.cardCount(),phase:game.phase});
    for(const p of game.players){
      assert(p.lives>=0,'lives non-negative',{g,p:p.id});
      assert(p.lives<=prevLives[p.id],'lives monotonic',{g,p:p.id});
      prevLives[p.id]=p.lives;
      if(p.eliminated) assert(p.lives===0,'eliminated has 0 lives',{g});
    }
  }

  assert(game.phase==='finished','match finished',{g});
  assert(game.winnerIds.length>=1,'has winner',{g});
  // every non-winner is eliminated; winners are not (unless mutual tie-out)
  const winners=game.winnerIds.map(id=>game.getPlayer(id));
  const allTiedOut = winners.every(w=>w.eliminated);
  for(const p of game.players){
    if(!game.winnerIds.includes(p.id)) assert(p.eliminated,'non-winner eliminated',{g,p:p.id});
  }
  if(!allTiedOut){ assert(winners.length===1 && !winners[0].eliminated,'single standing winner',{g}); }
}

console.log(`OK — ${GAMES} matches of 31, ${totalRounds} rounds, ${totalMoves} moves.`);
console.log(`Knocks: ${knocks}, 31s declared: ${declared31}, mutual-elimination ties: ${ties}`);

// ---- disconnect skip ----
(function disc(){
  const game=new ThirtyOneGame({rng:mulberry32(42)});
  const ps=[]; for(let i=0;i<4;i++) ps.push(game.addPlayer({token:'d'+i,name:'D'+i}));
  game.start();
  game.setConnected(ps[1].id,false);
  game.setConnected(ps[2].id,false);
  const rng=mulberry32(99); let steps=0;
  while(game.phase==='playing'){
    if(++steps>200000){ console.error('disc stalled'); process.exit(1); }
    if(game.reveal){ game.move(game.players[0].id,{type:'next_round'}); continue; }
    const cur=game.currentPlayer();
    assert(cur && cur.connected && !cur.eliminated,'current is connected+active',{turn:cur&&cur.id});
    if(game.turnPhase==='draw'){
      if(!game.knockerId && rng()<0.3 && game.activePlayers().length>=2) game.move(cur.id,{type:'knock'});
      else game.move(cur.id,{type:'draw',from:(game.discard.length>0&&rng()<0.5)?'discard':'stock'});
    } else { game.move(cur.id,{type:'discard',cardId:cur.hand[0].id}); }
    assert(game.cardCount()===52,'disc conservation');
  }
  console.log('OK — 31 disconnect test passed (away players skipped).');
})();

console.log('All 31 tests passed.');
