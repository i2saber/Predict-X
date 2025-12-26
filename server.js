// ============================================
// PREDICT X - Full Stack Prediction Market
// Single-file deployable server
// ============================================

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'predictx_secret_' + crypto.randomBytes(16).toString('hex');

// ============ IN-MEMORY DATABASE ============
const db = {
  users: new Map(),
  sessions: new Map(),
  markets: [],
  trades: [],
  positions: new Map(), // userId -> array of positions
  orderBook: new Map()  // marketId -> {yes: [], no: []}
};

// ============ MARKET GENERATION ============
const CATEGORIES = [
  {id:"crypto",name:"Crypto",icon:"₿",color:"#F7931A"},
  {id:"economy",name:"Economy",icon:"📈",color:"#00CED1"},
  {id:"sports",name:"Sports",icon:"🏈",color:"#30D158"},
  {id:"tech",name:"Tech",icon:"💻",color:"#AF52DE"},
  {id:"politics",name:"Politics",icon:"🏛️",color:"#FF6B6B"},
  {id:"entertainment",name:"Entertainment",icon:"🎬",color:"#FF9500"}
];

const TITLES = {
  crypto:["Bitcoin exceed $%dK","Ethereum reach $%dK","Solana hit $%d","BTC dominance above %d%","Crypto market cap $%dT"],
  economy:["Fed cut rates %d times","Inflation below %d%","S&P 500 reach %d","Gold reach $%dK","Oil above $%d"],
  sports:["Chiefs win Super Bowl","Lakers win Finals","World Cup winner %d goals","Olympics %d golds","UFC PPV record"],
  tech:["GPT-%d release","Apple foldable launch","Tesla FSD level %d","SpaceX Starship success","AI regulations %d countries"],
  politics:["Election turnout %d%","Senate flip","Trade deal signed","Climate accord %d nations","Infrastructure $%dB"],
  entertainment:["Movie gross $%dB","Album %dM sales","Netflix hit %dM","Streaming record","Concert $%dM tour"]
};

function generateMarkets() {
  let id = 0;
  CATEGORIES.forEach(c => {
    for (let i = 0; i < 100; i++) {
      const template = TITLES[c.id][Math.floor(Math.random() * TITLES[c.id].length)];
      const num = Math.floor(Math.random() * 900) + 100;
      const title = template.replace("%d", num);
      const yes = Math.floor(Math.random() * 80) + 10;
      
      db.markets.push({
        id: id++,
        title: "Will " + title + " by 2025?",
        cat: c.id,
        catName: c.name,
        icon: c.icon,
        color: c.color,
        yes: yes,
        no: 100 - yes,
        vol: Math.floor(Math.random() * 5000000) + 100000,
        users: Math.floor(Math.random() * 10000) + 100,
        days: Math.floor(Math.random() * 300) + 30,
        history: Array(30).fill(0).map(() => Math.floor(Math.random() * 60) + 20),
        lastUpdate: Date.now()
      });
      
      db.orderBook.set(id - 1, { yes: [], no: [] });
    }
  });
}

// ============ AUTH HELPERS ============
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + JWT_SECRET).digest('hex');
}

function generateToken(userId) {
  const payload = { userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64');
  return data + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64');
  if (sig !== expectedSig) return null;
  const payload = JSON.parse(Buffer.from(data, 'base64').toString());
  if (payload.exp < Date.now()) return null;
  return payload.userId;
}

function getUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const userId = verifyToken(auth.slice(7));
  return userId ? db.users.get(userId) : null;
}

// ============ PRICE ENGINE ============
function updatePrices() {
  db.markets.forEach(m => {
    const change = (Math.random() - 0.5) * 3;
    m.yes = Math.max(1, Math.min(99, Math.round(m.yes + change)));
    m.no = 100 - m.yes;
    m.history.shift();
    m.history.push(m.yes);
    m.lastUpdate = Date.now();
  });
}

setInterval(updatePrices, 500);

// ============ API ROUTES ============
const routes = {
  // Auth
  'POST /api/register': (req, body) => {
    const { username, email, password } = body;
    if (!username || !email || !password) return { error: 'Missing fields', status: 400 };
    if (username.length < 3) return { error: 'Username too short', status: 400 };
    if (password.length < 6) return { error: 'Password too short', status: 400 };
    
    const existing = [...db.users.values()].find(u => u.email === email || u.username === username);
    if (existing) return { error: 'User already exists', status: 400 };
    
    const id = crypto.randomUUID();
    const user = {
      id,
      username,
      email,
      password: hashPassword(password),
      balance: 10000,
      created: Date.now(),
      wins: 0,
      losses: 0
    };
    db.users.set(id, user);
    db.positions.set(id, []);
    
    const token = generateToken(id);
    return { token, user: { id, username, email, balance: user.balance } };
  },
  
  'POST /api/login': (req, body) => {
    const { email, password } = body;
    const user = [...db.users.values()].find(u => u.email === email);
    if (!user || user.password !== hashPassword(password)) {
      return { error: 'Invalid credentials', status: 401 };
    }
    const token = generateToken(user.id);
    return { token, user: { id: user.id, username: user.username, email, balance: user.balance } };
  },
  
  'GET /api/me': (req) => {
    const user = getUser(req);
    if (!user) return { error: 'Unauthorized', status: 401 };
    const positions = db.positions.get(user.id) || [];
    return { 
      user: { id: user.id, username: user.username, email: user.email, balance: user.balance, wins: user.wins, losses: user.losses },
      positions 
    };
  },
  
  // Markets
  'GET /api/markets': (req) => {
    const url = new URL(req.url, 'http://localhost');
    const cat = url.searchParams.get('cat');
    const search = url.searchParams.get('q')?.toLowerCase();
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const offset = parseInt(url.searchParams.get('offset')) || 0;
    
    let markets = db.markets;
    if (cat && cat !== 'all') markets = markets.filter(m => m.cat === cat);
    if (search) markets = markets.filter(m => m.title.toLowerCase().includes(search));
    
    return {
      total: markets.length,
      markets: markets.slice(offset, offset + limit).map(m => ({
        id: m.id, title: m.title, cat: m.cat, catName: m.catName, icon: m.icon, color: m.color,
        yes: m.yes, no: m.no, vol: m.vol, users: m.users, days: m.days
      }))
    };
  },
  
  'GET /api/markets/:id': (req) => {
    const id = parseInt(req.params.id);
    const m = db.markets[id];
    if (!m) return { error: 'Market not found', status: 404 };
    return { market: m };
  },
  
  // Trading
  'POST /api/trade': (req, body) => {
    const user = getUser(req);
    if (!user) return { error: 'Unauthorized', status: 401 };
    
    const { marketId, side, amount } = body;
    if (!['YES', 'NO'].includes(side)) return { error: 'Invalid side', status: 400 };
    if (amount <= 0 || amount > user.balance) return { error: 'Invalid amount', status: 400 };
    
    const market = db.markets[marketId];
    if (!market) return { error: 'Market not found', status: 404 };
    
    const price = side === 'YES' ? market.yes : market.no;
    const shares = Math.floor(amount / (price / 100));
    
    user.balance -= amount;
    market.vol += amount;
    market.users++;
    
    const positions = db.positions.get(user.id) || [];
    const existing = positions.find(p => p.marketId === marketId && p.side === side);
    
    if (existing) {
      const totalShares = existing.shares + shares;
      existing.avg = ((existing.avg * existing.shares) + (price * shares)) / totalShares;
      existing.shares = totalShares;
    } else {
      positions.push({
        id: crypto.randomUUID(),
        marketId,
        title: market.title.substring(0, 40),
        side,
        shares,
        avg: price,
        openedAt: Date.now()
      });
    }
    
    db.trades.push({
      id: crypto.randomUUID(),
      userId: user.id,
      marketId,
      side,
      shares,
      price,
      amount,
      timestamp: Date.now()
    });
    
    return { success: true, balance: user.balance, shares };
  },
  
  'POST /api/sell': (req, body) => {
    const user = getUser(req);
    if (!user) return { error: 'Unauthorized', status: 401 };
    
    const { positionId } = body;
    const positions = db.positions.get(user.id) || [];
    const idx = positions.findIndex(p => p.id === positionId);
    if (idx === -1) return { error: 'Position not found', status: 404 };
    
    const pos = positions[idx];
    const market = db.markets[pos.marketId];
    const currentPrice = pos.side === 'YES' ? market.yes : market.no;
    const payout = pos.shares * (currentPrice / 100);
    
    user.balance += payout;
    if (currentPrice > pos.avg) user.wins++;
    else user.losses++;
    
    positions.splice(idx, 1);
    
    return { success: true, balance: user.balance, payout };
  },
  
  // Leaderboard
  'GET /api/leaderboard': () => {
    const users = [...db.users.values()]
      .map(u => ({
        username: u.username,
        balance: u.balance + (db.positions.get(u.id) || []).reduce((a, p) => {
          const m = db.markets[p.marketId];
          return a + p.shares * ((p.side === 'YES' ? m.yes : m.no) / 100);
        }, 0),
        wins: u.wins,
        winRate: u.wins + u.losses > 0 ? Math.round(u.wins / (u.wins + u.losses) * 100) : 0
      }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 100);
    
    return { leaderboard: users.map((u, i) => ({ ...u, rank: i + 1 })) };
  },
  
  // Stats
  'GET /api/stats': () => {
    return {
      totalMarkets: db.markets.length,
      totalUsers: db.users.size,
      totalVolume: db.markets.reduce((a, m) => a + m.vol, 0),
      totalTrades: db.trades.length
    };
  }
};

// ============ FRONTEND HTML ============
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>Predict X - Live Prediction Markets</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📈</text></svg>">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#000;color:#fff;min-height:100vh}
    .app{max-width:430px;margin:0 auto;min-height:100vh;position:relative;padding-bottom:70px}
    @media(min-width:500px){body{background:#111;padding:20px}.app{border-radius:24px;overflow:hidden;box-shadow:0 0 60px rgba(0,175,255,.15)}}
    
    /* Auth */
    .auth-overlay{position:fixed;inset:0;background:#000;display:flex;align-items:center;justify-content:center;z-index:1000}
    .auth-box{width:90%;max-width:360px;padding:32px 24px;text-align:center}
    .auth-logo{font-size:48px;margin-bottom:16px}
    .auth-title{font-size:28px;font-weight:700;margin-bottom:8px}
    .auth-sub{color:#8E8E93;margin-bottom:24px;font-size:14px}
    .auth-input{width:100%;background:#1C1C1E;border:1px solid #2C2C2E;border-radius:12px;padding:14px 16px;color:#fff;font-size:16px;margin-bottom:12px;outline:none}
    .auth-input:focus{border-color:#00AFFF}
    .auth-btn{width:100%;background:#00AFFF;color:#000;border:none;border-radius:12px;padding:16px;font-size:16px;font-weight:600;cursor:pointer;margin-top:8px}
    .auth-btn:disabled{opacity:.5}
    .auth-switch{color:#8E8E93;margin-top:20px;font-size:14px}
    .auth-switch a{color:#00AFFF;cursor:pointer}
    .auth-error{color:#FF453A;font-size:13px;margin-bottom:12px}
    .auth-stats{display:flex;justify-content:center;gap:24px;margin-top:32px;padding-top:24px;border-top:1px solid #2C2C2E}
    .auth-stat{text-align:center}
    .auth-stat div:first-child{font-size:20px;font-weight:700;color:#00AFFF}
    .auth-stat div:last-child{font-size:11px;color:#8E8E93}
    
    /* Header */
    .header{padding:16px;background:#000;position:sticky;top:0;z-index:50}
    .header-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
    h1{font-size:22px;display:flex;align-items:center;gap:8px}
    .live{font-size:9px;background:#30D158;color:#000;padding:3px 8px;border-radius:10px;font-weight:600;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.7}}
    .user-info{display:flex;align-items:center;gap:10px}
    .balance-badge{background:#1C1C1E;padding:6px 12px;border-radius:20px;font-size:12px;font-weight:600}
    .balance-badge span{color:#30D158}
    .avatar-btn{width:36px;height:36px;border-radius:18px;background:linear-gradient(135deg,#00AFFF,#0077B6);border:none;font-size:16px;cursor:pointer}
    .search{background:#1C1C1E;border-radius:12px;padding:12px 16px;display:flex;gap:10px;margin-bottom:12px}
    .search input{background:none;border:none;color:#fff;flex:1;font-size:15px;outline:none}
    .pills{display:flex;gap:6px;overflow-x:auto;padding:4px 0}
    .pills::-webkit-scrollbar{display:none}
    .pill{background:#1C1C1E;color:#fff;border:none;border-radius:20px;padding:10px 14px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;transition:all .2s;display:flex;align-items:center;gap:6px}
    .pill.active{background:#00AFFF;color:#000}
    .pill .cnt{font-size:10px;opacity:.6}
    
    /* Content */
    .content{padding:0 16px}
    .stats-bar{display:flex;justify-content:space-between;padding:12px 0;font-size:11px;color:#8E8E93}
    .card{background:#1C1C1E;border-radius:14px;padding:14px;margin-bottom:10px;cursor:pointer;transition:transform .15s,background .15s}
    .card:active{transform:scale(.98);background:#252528}
    .card-head{display:flex;justify-content:space-between;margin-bottom:8px;font-size:11px}
    .card-cat{display:flex;align-items:center;gap:5px;font-weight:500}
    .card-meta{color:#8E8E93}
    .card h3{font-size:14px;font-weight:600;line-height:1.4;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .prices{display:flex;gap:10px}
    .pbtn{flex:1;border-radius:10px;padding:10px;display:flex;justify-content:space-between;align-items:center;border:none;cursor:pointer;transition:transform .1s}
    .pbtn:active{transform:scale(.97)}
    .pbtn.yes{background:rgba(48,209,88,.12)}
    .pbtn.no{background:rgba(255,69,58,.12)}
    .pbtn .side{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:#fff}
    .dot{width:6px;height:6px;border-radius:3px}
    .dot.g{background:#30D158}
    .dot.r{background:#FF453A}
    .pbtn .price{font-size:15px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums;transition:color .2s}
    .pbtn .price.up{color:#30D158}
    .pbtn .price.down{color:#FF453A}
    .card-foot{display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:#8E8E93}
    
    /* Tabs */
    .tabs{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:#0a0a0a;display:flex;justify-content:space-around;padding:10px 0 28px;border-top:1px solid #1C1C1E;z-index:50}
    .tab{background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;opacity:.5;transition:opacity .2s}
    .tab.active{opacity:1}
    .tab span:first-child{font-size:22px}
    .tab span:last-child{font-size:10px;color:#8E8E93}
    .tab.active span:last-child{color:#00AFFF}
    
    /* Modal */
    .modal{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:flex-end;justify-content:center;z-index:200}
    .modal.open{display:flex}
    .modal-box{background:#000;width:100%;max-width:430px;max-height:90vh;overflow-y:auto;border-radius:24px 24px 0 0;padding:20px}
    .modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
    .modal-head h2{font-size:16px;display:flex;align-items:center;gap:8px}
    .modal-close{background:none;border:none;color:#00AFFF;font-size:15px;cursor:pointer;padding:8px}
    .detail-box{background:#1C1C1E;border-radius:14px;padding:16px;margin-bottom:14px}
    .detail-box h3{font-size:16px;margin-bottom:8px}
    .detail-box p{font-size:13px;color:#8E8E93;line-height:1.5}
    .detail-stats{display:flex;justify-content:space-around;margin-top:14px;padding-top:14px;border-top:1px solid #2C2C2E}
    .dstat{text-align:center}
    .dstat div:first-child{font-size:15px;font-weight:600}
    .dstat div:last-child{font-size:10px;color:#8E8E93;margin-top:2px}
    .chart-box{background:#1C1C1E;border-radius:14px;padding:16px;margin-bottom:14px;position:relative}
    .chart-price{font-size:24px;font-weight:700}
    .chart-chg{font-size:12px;margin-left:8px}
    .chart-chg.up{color:#30D158}
    .chart-chg.down{color:#FF453A}
    .chart-svg{height:100px;margin:12px 0}
    .chart-svg svg{width:100%;height:100%}
    .chart-labels{display:flex;justify-content:space-between;font-size:10px;color:#8E8E93}
    .trade-btns{display:flex;gap:12px}
    .tbtn{flex:1;padding:18px;border-radius:14px;text-align:center;cursor:pointer;border:2px solid;transition:transform .15s}
    .tbtn:active{transform:scale(.97)}
    .tbtn.yes{background:rgba(48,209,88,.15);border-color:#30D158}
    .tbtn.no{background:rgba(255,69,58,.15);border-color:#FF453A}
    .tbtn div:first-child{font-size:13px;font-weight:600}
    .tbtn div:nth-child(2){font-size:24px;font-weight:700;margin:6px 0}
    .tbtn.yes div:last-child{font-size:11px;color:#30D158}
    .tbtn.no div:last-child{font-size:11px;color:#FF453A}
    .trade-input{margin-top:16px}
    .trade-input label{font-size:12px;color:#8E8E93;display:block;margin-bottom:8px}
    .trade-input input{width:100%;background:#1C1C1E;border:2px solid #2C2C2E;border-radius:12px;padding:14px;color:#fff;font-size:18px;font-weight:600;text-align:center;outline:none}
    .trade-input input:focus{border-color:#00AFFF}
    .trade-summary{background:#1C1C1E;border-radius:12px;padding:14px;margin-top:12px}
    .trade-row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px}
    .trade-row span:first-child{color:#8E8E93}
    .trade-confirm{width:100%;padding:18px;border-radius:14px;font-size:16px;font-weight:600;border:none;cursor:pointer;margin-top:16px}
    .trade-confirm.yes{background:#30D158;color:#000}
    .trade-confirm.no{background:#FF453A;color:#fff}
    .trade-confirm:disabled{opacity:.5}
    
    /* Wallet */
    .wallet-hero{background:linear-gradient(135deg,#1C1C1E 0%,#0a0a0a 100%);border-radius:20px;padding:28px;text-align:center;margin-bottom:16px;position:relative;overflow:hidden}
    .wallet-hero::before{content:"";position:absolute;top:-50%;right:-50%;width:100%;height:100%;background:radial-gradient(circle,rgba(0,175,255,.1) 0%,transparent 70%)}
    .wallet-label{font-size:12px;color:#8E8E93}
    .wallet-amount{font-size:42px;font-weight:700;margin:10px 0}
    .wallet-sub{display:flex;justify-content:center;gap:40px;margin:20px 0}
    .wallet-sub div{text-align:center}
    .wallet-sub .val{font-size:16px;font-weight:600}
    .wallet-sub .lbl{font-size:11px;color:#8E8E93}
    .wallet-actions{display:flex;gap:12px;margin-top:8px}
    .wallet-actions button{flex:1;padding:14px;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;border:none}
    .btn-p{background:#00AFFF;color:#000}
    .btn-s{background:rgba(0,175,255,.15);color:#00AFFF}
    
    .section{background:#1C1C1E;border-radius:16px;padding:16px;margin-bottom:14px}
    .section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
    .section-head h3{font-size:14px;font-weight:600}
    .section-head span{font-size:12px;color:#8E8E93}
    .pos-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #2C2C2E}
    .pos-row:last-child{border:none}
    .pos-info h4{font-size:13px;font-weight:500;margin-bottom:3px}
    .pos-meta{font-size:11px}
    .pos-meta .grn{color:#30D158}
    .pos-meta .gry{color:#8E8E93}
    .pos-val{text-align:right}
    .pos-val .amt{font-size:14px;font-weight:600}
    .pos-val .pnl{font-size:11px}
    .pos-val .up{color:#30D158}
    .pos-val .dn{color:#FF453A}
    .sell-btn{background:#2C2C2E;border:none;color:#FF453A;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:500;cursor:pointer;margin-left:10px}
    
    /* Profile */
    .profile-hero{background:linear-gradient(135deg,#1C1C1E 0%,#0a0a0a 100%);border-radius:20px;padding:28px;text-align:center;margin-bottom:16px}
    .profile-avatar{width:80px;height:80px;border-radius:40px;background:linear-gradient(135deg,#00AFFF,#0077B6);display:flex;align-items:center;justify-content:center;font-size:36px;margin:0 auto 14px}
    .profile-name{font-size:22px;font-weight:700}
    .profile-email{font-size:13px;color:#8E8E93;margin-top:4px}
    .logout-btn{margin-top:16px;background:#2C2C2E;border:none;color:#FF453A;padding:10px 24px;border-radius:20px;font-size:13px;cursor:pointer}
    .stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
    .stat-card{background:#1C1C1E;border-radius:14px;padding:18px;text-align:center}
    .stat-card .icon{font-size:26px;margin-bottom:8px}
    .stat-card .val{font-size:22px;font-weight:700}
    .stat-card .lbl{font-size:11px;color:#8E8E93;margin-top:4px}
    .leader-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #2C2C2E}
    .leader-row:last-child{border:none}
    .leader-row.you{background:rgba(0,175,255,.08);margin:0 -16px;padding:12px 16px;border-radius:10px}
    .l-rank{width:28px;font-size:15px;font-weight:700;color:#8E8E93}
    .l-rank.g{color:#FFD700}
    .l-rank.s{color:#C0C0C0}
    .l-rank.b{color:#CD7F32}
    .l-avatar{width:36px;height:36px;border-radius:18px;background:#2C2C2E;display:flex;align-items:center;justify-content:center;font-size:16px}
    .you .l-avatar{background:linear-gradient(135deg,#00AFFF,#0077B6)}
    .l-info{flex:1}
    .l-name{font-size:14px;font-weight:500;display:flex;align-items:center;gap:8px}
    .l-wr{font-size:11px;color:#8E8E93;margin-top:2px}
    .l-bal{font-size:14px;font-weight:600;color:#30D158}
    .you-badge{font-size:9px;background:rgba(0,175,255,.2);color:#00AFFF;padding:3px 8px;border-radius:6px}
    
    .empty{text-align:center;padding:48px 24px;color:#8E8E93}
    .empty span{font-size:48px;display:block;margin-bottom:12px}
    .loader{text-align:center;padding:24px;color:#8E8E93}
  </style>
</head>
<body>
<div class="app">
  <div id="auth" class="auth-overlay"></div>
  <div id="main" style="display:none">
    <div class="header" id="header"></div>
    <div class="content" id="content"></div>
    <div class="tabs" id="tabs"></div>
  </div>
  <div class="modal" id="modal"></div>
</div>

<script>
const API = '';
let user = null;
let token = localStorage.getItem('px_token');
let markets = [];
let positions = [];
let leaderboard = [];
let tab = 'home';
let cat = 'all';
let search = '';
let stats = {};
let priceCache = {};

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ============ AUTH ============
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function checkAuth() {
  if (!token) return showAuth();
  try {
    const data = await api('/api/me');
    user = data.user;
    positions = data.positions;
    showApp();
  } catch (e) {
    localStorage.removeItem('px_token');
    token = null;
    showAuth();
  }
}

function showAuth() {
  $('#main').style.display = 'none';
  $('#auth').style.display = 'flex';
  renderAuth('login');
}

function renderAuth(mode) {
  api('/api/stats').then(s => stats = s).catch(() => {});
  
  $('#auth').innerHTML = \`
    <div class="auth-box">
      <div class="auth-logo">📈</div>
      <div class="auth-title">Predict X</div>
      <div class="auth-sub">\${mode === 'login' ? 'Welcome back! Sign in to trade.' : 'Create account to start trading'}</div>
      <div id="authError" class="auth-error" style="display:none"></div>
      \${mode === 'register' ? '<input class="auth-input" id="authUser" placeholder="Username" autocomplete="off">' : ''}
      <input class="auth-input" id="authEmail" type="email" placeholder="Email" autocomplete="email">
      <input class="auth-input" id="authPass" type="password" placeholder="Password" autocomplete="\${mode === 'login' ? 'current-password' : 'new-password'}">
      <button class="auth-btn" id="authBtn">\${mode === 'login' ? 'Sign In' : 'Create Account'}</button>
      <div class="auth-switch">
        \${mode === 'login' ? "Don't have an account? <a onclick=\\"renderAuth('register')\\">Sign up</a>" : "Already have an account? <a onclick=\\"renderAuth('login')\\">Sign in</a>"}
      </div>
      <div class="auth-stats">
        <div class="auth-stat"><div>\${(stats.totalMarkets || 600).toLocaleString()}</div><div>Markets</div></div>
        <div class="auth-stat"><div>\${(stats.totalUsers || 0).toLocaleString()}</div><div>Traders</div></div>
        <div class="auth-stat"><div>$\${((stats.totalVolume || 0) / 1e9).toFixed(1)}B</div><div>Volume</div></div>
      </div>
    </div>
  \`;
  
  $('#authBtn').onclick = async () => {
    const email = $('#authEmail').value;
    const pass = $('#authPass').value;
    const username = $('#authUser')?.value;
    
    $('#authBtn').disabled = true;
    $('#authError').style.display = 'none';
    
    try {
      const endpoint = mode === 'login' ? '/api/login' : '/api/register';
      const body = mode === 'login' ? { email, password: pass } : { username, email, password: pass };
      const data = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      
      token = data.token;
      user = data.user;
      localStorage.setItem('px_token', token);
      positions = [];
      showApp();
    } catch (e) {
      $('#authError').textContent = e.message;
      $('#authError').style.display = 'block';
      $('#authBtn').disabled = false;
    }
  };
}

function logout() {
  localStorage.removeItem('px_token');
  token = null;
  user = null;
  showAuth();
}

// ============ APP ============
async function showApp() {
  $('#auth').style.display = 'none';
  $('#main').style.display = 'block';
  
  await loadMarkets();
  render();
  startPriceUpdates();
}

async function loadMarkets() {
  try {
    const params = new URLSearchParams({ limit: 100, cat, q: search });
    const data = await api('/api/markets?' + params);
    markets = data.markets;
    markets.forEach(m => priceCache[m.id] = { yes: m.yes, no: m.no });
  } catch (e) {
    console.error(e);
  }
}

function startPriceUpdates() {
  setInterval(async () => {
    if (tab !== 'home' && tab !== 'markets') return;
    try {
      const ids = [...$$('.card')].slice(0, 20).map(c => c.dataset.id);
      const data = await api('/api/markets?limit=20&cat=' + cat);
      data.markets.forEach(m => {
        const old = priceCache[m.id] || { yes: m.yes, no: m.no };
        priceCache[m.id] = { yes: m.yes, no: m.no };
        
        const card = $(\`.card[data-id="\${m.id}"]\`);
        if (!card) return;
        
        const yesEl = card.querySelector('.yes-p');
        const noEl = card.querySelector('.no-p');
        if (yesEl) {
          yesEl.textContent = m.yes + '¢';
          yesEl.className = 'price yes-p' + (m.yes > old.yes ? ' up' : m.yes < old.yes ? ' down' : '');
        }
        if (noEl) {
          noEl.textContent = m.no + '¢';
          noEl.className = 'price no-p' + (m.no > old.no ? ' up' : m.no < old.no ? ' down' : '');
        }
      });
    } catch (e) {}
  }, 1000);
}

function render() {
  renderHeader();
  renderContent();
  renderTabs();
}

function renderHeader() {
  if (tab === 'home' || tab === 'markets') {
    $('#header').innerHTML = \`
      <div class="header-top">
        <h1>📈 Predict X <span class="live">LIVE</span></h1>
        <div class="user-info">
          <div class="balance-badge">💰 <span>$\${user.balance.toFixed(2)}</span></div>
          <button class="avatar-btn" onclick="tab='profile';render()">👤</button>
        </div>
      </div>
      <div class="search">
        <span>🔍</span>
        <input id="searchInput" placeholder="Search markets..." value="\${search}">
      </div>
      <div class="pills">
        <button class="pill\${cat==='all'?' active':''}" data-cat="all">All</button>
        <button class="pill\${cat==='crypto'?' active':''}" data-cat="crypto">₿ Crypto</button>
        <button class="pill\${cat==='economy'?' active':''}" data-cat="economy">📈 Economy</button>
        <button class="pill\${cat==='sports'?' active':''}" data-cat="sports">🏈 Sports</button>
        <button class="pill\${cat==='tech'?' active':''}" data-cat="tech">💻 Tech</button>
        <button class="pill\${cat==='politics'?' active':''}" data-cat="politics">🏛️ Politics</button>
        <button class="pill\${cat==='entertainment'?' active':''}" data-cat="entertainment">🎬 Entertainment</button>
      </div>
    \`;
    
    $$('.pill').forEach(p => p.onclick = async () => {
      cat = p.dataset.cat;
      $$('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      await loadMarkets();
      renderContent();
    });
    
    $('#searchInput').oninput = async (e) => {
      search = e.target.value;
      await loadMarkets();
      renderContent();
    };
  } else {
    $('#header').innerHTML = \`
      <div class="header-top">
        <h1>\${tab === 'wallet' ? '💰 Wallet' : '👤 Profile'}</h1>
        <div class="user-info">
          <div class="balance-badge">💰 <span>$\${user.balance.toFixed(2)}</span></div>
        </div>
      </div>
    \`;
  }
}

function renderContent() {
  const c = $('#content');
  
  if (tab === 'home' || tab === 'markets') {
    c.innerHTML = \`
      <div class="stats-bar">
        <span>Showing \${markets.length} markets</span>
        <span>Updated live</span>
      </div>
      \${markets.map(cardHTML).join('')}
    \`;
    $$('.card').forEach(card => {
      card.onclick = () => showMarketModal(parseInt(card.dataset.id));
    });
  } else if (tab === 'wallet') {
    renderWallet();
  } else {
    renderProfile();
  }
}

function cardHTML(m) {
  return \`
    <div class="card" data-id="\${m.id}">
      <div class="card-head">
        <span class="card-cat" style="color:\${m.color}">\${m.icon} \${m.catName}</span>
        <span class="card-meta">👥 \${formatNum(m.users)} • \${m.days}d</span>
      </div>
      <h3>\${m.title}</h3>
      <div class="prices">
        <div class="pbtn yes"><div class="side"><div class="dot g"></div>YES</div><span class="price yes-p">\${m.yes}¢</span></div>
        <div class="pbtn no"><div class="side"><div class="dot r"></div>NO</div><span class="price no-p">\${m.no}¢</span></div>
      </div>
      <div class="card-foot"><span>📊 $\${formatNum(m.vol)}</span><span>#\${m.id + 1}</span></div>
    </div>
  \`;
}

async function showMarketModal(id) {
  try {
    const data = await api('/api/markets/' + id);
    const m = data.market;
    const pts = m.history.map((v, i) => \`\${i * (100 / 30)},\${100 - v}\`).join(' ');
    const change = m.yes - m.history[0];
    
    $('#modal').innerHTML = \`
      <div class="modal-box">
        <div class="modal-head">
          <h2 style="color:\${m.color}">\${m.icon} \${m.catName}</h2>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        
        <div class="detail-box">
          <h3>\${m.title}</h3>
          <p>Trade on the outcome. Buy YES if you think it will happen, NO if it won't. Shares pay $1 if correct.</p>
          <div class="detail-stats">
            <div class="dstat"><div>⏱️ \${m.days}d</div><div>Remaining</div></div>
            <div class="dstat"><div>👥 \${formatNum(m.users)}</div><div>Traders</div></div>
            <div class="dstat"><div>📊 $\${formatNum(m.vol)}</div><div>Volume</div></div>
          </div>
        </div>
        
        <div class="chart-box">
          <span class="chart-price">\${m.yes}¢</span>
          <span class="chart-chg \${change >= 0 ? 'up' : 'down'}">\${change >= 0 ? '+' : ''}\${change.toFixed(1)}%</span>
          <div class="chart-svg">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
              <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#30D158" stop-opacity="0.3"/><stop offset="100%" stop-color="#30D158" stop-opacity="0"/></linearGradient></defs>
              <polygon points="0,100 \${pts} 100,100" fill="url(#cg)"/>
              <polyline points="\${pts}" fill="none" stroke="#30D158" stroke-width="2"/>
            </svg>
          </div>
          <div class="chart-labels"><span>30d ago</span><span>Now</span></div>
        </div>
        
        <div class="trade-btns">
          <div class="tbtn yes" onclick="showTradeForm(\${m.id},'YES',\${m.yes})"><div>YES</div><div>\${m.yes}¢</div><div>Buy YES</div></div>
          <div class="tbtn no" onclick="showTradeForm(\${m.id},'NO',\${m.no})"><div>NO</div><div>\${m.no}¢</div><div>Buy NO</div></div>
        </div>
        
        <div id="tradeForm"></div>
      </div>
    \`;
    $('#modal').classList.add('open');
  } catch (e) {
    alert('Error loading market');
  }
}

function showTradeForm(marketId, side, price) {
  const max = Math.floor(user.balance);
  $('#tradeForm').innerHTML = \`
    <div class="trade-input">
      <label>Amount to invest</label>
      <input type="number" id="tradeAmount" value="10" min="1" max="\${max}" placeholder="Enter amount">
    </div>
    <div class="trade-summary">
      <div class="trade-row"><span>Price per share</span><span>\${price}¢</span></div>
      <div class="trade-row"><span>Shares</span><span id="tradeShares">\${Math.floor(10 / (price / 100))}</span></div>
      <div class="trade-row"><span>Potential payout</span><span id="tradePayout">$\${Math.floor(10 / (price / 100)).toFixed(2)}</span></div>
    </div>
    <button class="trade-confirm \${side.toLowerCase()}" id="tradeBtn" onclick="executeTrade(\${marketId},'\${side}')">Buy \${side} for $<span id="tradeTotal">10</span></button>
  \`;
  
  $('#tradeAmount').oninput = (e) => {
    const amt = parseFloat(e.target.value) || 0;
    const shares = Math.floor(amt / (price / 100));
    $('#tradeShares').textContent = shares;
    $('#tradePayout').textContent = '$' + shares.toFixed(2);
    $('#tradeTotal').textContent = amt;
    $('#tradeBtn').disabled = amt <= 0 || amt > user.balance;
  };
}

async function executeTrade(marketId, side) {
  const amount = parseFloat($('#tradeAmount').value);
  if (!amount || amount <= 0 || amount > user.balance) return;
  
  $('#tradeBtn').disabled = true;
  
  try {
    const data = await api('/api/trade', {
      method: 'POST',
      body: JSON.stringify({ marketId, side, amount })
    });
    
    user.balance = data.balance;
    positions.push({ marketId, side, shares: data.shares });
    
    closeModal();
    render();
    alert(\`✅ Bought \${data.shares} \${side} shares!\`);
  } catch (e) {
    alert('Trade failed: ' + e.message);
    $('#tradeBtn').disabled = false;
  }
}

async function renderWallet() {
  try {
    const data = await api('/api/me');
    positions = data.positions;
    user = data.user;
  } catch (e) {}
  
  const posValue = positions.reduce((a, p) => {
    const m = markets.find(x => x.id === p.marketId) || { yes: 50, no: 50 };
    const cur = p.side === 'YES' ? m.yes : m.no;
    return a + p.shares * (cur / 100);
  }, 0);
  
  $('#content').innerHTML = \`
    <div class="wallet-hero">
      <div class="wallet-label">Total Balance</div>
      <div class="wallet-amount">$\${(user.balance + posValue).toFixed(2)}</div>
      <div class="wallet-sub">
        <div><div class="val">$\${user.balance.toFixed(2)}</div><div class="lbl">Available</div></div>
        <div><div class="val">$\${posValue.toFixed(2)}</div><div class="lbl">In Positions</div></div>
      </div>
      <div class="wallet-actions">
        <button class="btn-p" onclick="deposit()">⬇️ Deposit $1,000</button>
        <button class="btn-s">⬆️ Withdraw</button>
      </div>
    </div>
    
    <div class="section">
      <div class="section-head"><h3>Open Positions</h3><span>\${positions.length}</span></div>
      \${positions.length === 0 ? '<div class="empty"><span>📭</span>No positions yet.<br>Start trading!</div>' : positions.map(positionHTML).join('')}
    </div>
  \`;
}

function positionHTML(p) {
  const m = markets.find(x => x.id === p.marketId) || { yes: 50, no: 50, title: 'Market' };
  const cur = p.side === 'YES' ? m.yes : m.no;
  const val = (p.shares * cur / 100).toFixed(2);
  const pnl = ((cur - p.avg) / p.avg * 100).toFixed(1);
  const up = parseFloat(pnl) >= 0;
  
  return \`
    <div class="pos-row">
      <div class="pos-info">
        <h4>\${p.title || m.title?.substring(0, 30)}</h4>
        <div class="pos-meta"><span class="grn">\${p.shares} \${p.side}</span> <span class="gry">@ \${p.avg}¢</span></div>
      </div>
      <div style="display:flex;align-items:center">
        <div class="pos-val">
          <div class="amt">$\${val}</div>
          <div class="pnl \${up ? 'up' : 'dn'}">\${up ? '↗' : '↘'} \${up ? '+' : ''}\${pnl}%</div>
        </div>
        <button class="sell-btn" onclick="sellPosition('\${p.id}')">Sell</button>
      </div>
    </div>
  \`;
}

async function sellPosition(positionId) {
  if (!confirm('Sell this position?')) return;
  
  try {
    const data = await api('/api/sell', {
      method: 'POST',
      body: JSON.stringify({ positionId })
    });
    user.balance = data.balance;
    alert(\`Sold for $\${data.payout.toFixed(2)}!\`);
    renderWallet();
    renderHeader();
  } catch (e) {
    alert('Sell failed: ' + e.message);
  }
}

async function deposit() {
  user.balance += 1000;
  renderWallet();
  renderHeader();
}

async function renderProfile() {
  try {
    const data = await api('/api/leaderboard');
    leaderboard = data.leaderboard;
  } catch (e) {}
  
  const wr = user.wins + user.losses > 0 ? Math.round(user.wins / (user.wins + user.losses) * 100) : 0;
  const myRank = leaderboard.findIndex(l => l.username === user.username) + 1 || 99;
  
  $('#content').innerHTML = \`
    <div class="profile-hero">
      <div class="profile-avatar">👤</div>
      <div class="profile-name">@\${user.username}</div>
      <div class="profile-email">\${user.email}</div>
      <button class="logout-btn" onclick="logout()">Sign Out</button>
    </div>
    
    <div class="stats-grid">
      <div class="stat-card"><div class="icon">📊</div><div class="val">\${wr}%</div><div class="lbl">Win Rate</div></div>
      <div class="stat-card"><div class="icon">💰</div><div class="val">$\${user.balance.toFixed(0)}</div><div class="lbl">Balance</div></div>
      <div class="stat-card"><div class="icon">✅</div><div class="val">\${user.wins}</div><div class="lbl">Wins</div></div>
      <div class="stat-card"><div class="icon">🏆</div><div class="val">#\${myRank}</div><div class="lbl">Rank</div></div>
    </div>
    
    <div class="section">
      <div class="section-head"><h3>🏆 Leaderboard</h3></div>
      \${leaderboard.slice(0, 10).map((l, i) => \`
        <div class="leader-row\${l.username === user.username ? ' you' : ''}">
          <div class="l-rank \${i === 0 ? 'g' : i === 1 ? 's' : i === 2 ? 'b' : ''}">\${l.rank}</div>
          <div class="l-avatar">\${i < 3 ? ['🥇','🥈','🥉'][i] : '👤'}</div>
          <div class="l-info">
            <div class="l-name">\${l.username}\${l.username === user.username ? '<span class="you-badge">You</span>' : ''}</div>
            <div class="l-wr">\${l.winRate}% win rate</div>
          </div>
          <div class="l-bal">$\${l.balance.toFixed(0)}</div>
        </div>
      \`).join('')}
    </div>
  \`;
}

function renderTabs() {
  $('#tabs').innerHTML = [
    { id: 'home', icon: '🏠', label: 'Home' },
    { id: 'markets', icon: '📊', label: 'Markets' },
    { id: 'wallet', icon: '💰', label: 'Wallet' },
    { id: 'profile', icon: '👤', label: 'Profile' }
  ].map(t => \`
    <button class="tab\${tab === t.id ? ' active' : ''}" data-tab="\${t.id}">
      <span>\${t.icon}</span><span>\${t.label}</span>
    </button>
  \`).join('');
  
  $$('.tab').forEach(t => t.onclick = () => {
    tab = t.dataset.tab;
    render();
  });
}

function closeModal() {
  $('#modal').classList.remove('open');
}

$('#modal').onclick = e => {
  if (e.target === $('#modal')) closeModal();
};

function formatNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

// Init
checkAuth();
</script>
</body>
</html>`;

// ============ HTTP SERVER ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method;
  const path = url.pathname;
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  
  // Serve frontend
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HTML);
  }
  
  // API routes
  const routeKey = `${method} ${path.replace(/\/\d+$/, '/:id')}`;
  const handler = routes[routeKey];
  
  if (handler) {
    let body = {};
    if (method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    }
    
    // Extract params
    const idMatch = path.match(/\/(\d+)$/);
    req.params = idMatch ? { id: idMatch[1] } : {};
    req.url = url.href;
    
    try {
      const result = await handler(req, body);
      const status = result.status || 200;
      delete result.status;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// Initialize and start
generateMarkets();
server.listen(PORT, () => {
  console.log(\`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 PREDICT X - Live Prediction Markets                  ║
║                                                           ║
║   Server running at: http://localhost:\${PORT}              ║
║                                                           ║
║   Markets: \${db.markets.length}                                       ║
║   Categories: \${CATEGORIES.length}                                         ║
║   Price updates: Every 500ms                              ║
║                                                           ║
║   Deploy to:                                              ║
║   • Railway: railway up                                   ║
║   • Render: Connect GitHub repo                           ║
║   • Fly.io: fly launch                                    ║
║   • Heroku: git push heroku main                          ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  \`);
});
