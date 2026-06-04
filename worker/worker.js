// Cloudflare Worker 简单后端（使用 KV）
// 需要在 wrangler.toml 中绑定 KV 命名空间：USERS, NICKMAP, IPMAP, SESSIONS, CHATS, MESSAGES

addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

async function handle(request){
  const url = new URL(request.url);
  if(url.pathname.startsWith('/api/')){
    try{
      return await handleApi(request,url);
    }catch(e){
      return json({success:false,error:e.message},500);
    }
  }
  return fetch(request);
}

function json(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json'}})}

async function handleApi(request,url){
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const path = url.pathname.replace('/api/','');
  const parts = path.split('/').filter(Boolean);
  if(parts[0]==='register' && request.method==='POST'){
    const body = await request.json();
    return registerHandler(body,ip);
  }
  if(parts[0]==='login' && request.method==='POST'){
    const body = await request.json();
    return loginHandler(body);
  }
  // auth required
  const user = await auth(request);
  if(!user) return json({success:false,error:'未授权'},401);

  if(parts[0]==='me' && request.method==='GET'){
    return json({success:true,user});
  }

  if(parts[0]==='chats'){
    if(parts.length===1 && request.method==='GET'){
      // list chats for user
      const all = await CHATS.list({prefix:'chat:'});
      // CHATS.list not directly supported in this snippet; instead store index of chats per user
      const chatIndexKey = `user_chats:${user.id}`;
      const chatIdsText = await CHATS.get(chatIndexKey);
      const chatIds = chatIdsText?JSON.parse(chatIdsText):[];
      const chats = [];
      for(const id of chatIds){
        const ctext = await CHATS.get(`chat:${id}`);
        if(ctext) chats.push(JSON.parse(ctext));
      }
      return json({success:true,chats});
    }
    if(parts.length===1 && request.method==='POST'){
      const body = await request.json();
      return createChatHandler(user,body);
    }
    if(parts.length>=2){
      const chatId = parts[1];
      if(parts.length===3 && parts[2]==='messages' && request.method==='GET'){
        // list messages
        const msgsText = await MESSAGES.get(`chat_msgs:${chatId}`);
        const msgs = msgsText?JSON.parse(msgsText):[];
        return json({success:true,messages:msgs});
      }
      if(parts.length===3 && parts[2]==='messages' && request.method==='POST'){
        const body = await request.json();
        return postMessageHandler(user,chatId,body);
      }
    }
  }

  return json({success:false,error:'未找到接口'},404);
}

// helpers
async function registerHandler(body, ip){
  const {nickname,password} = body||{};
  if(!nickname||!password) return json({success:false,error:'昵称和密码必填'},400);
  // check IP unique
  const ipKey = `ip:${ip}`;
  const existing = await IPMAP.get(ipKey);
  if(existing) return json({success:false,error:'同一 IP 只能注册一个账号'},403);
  // check nickname unique
  const nickKey = `nick:${nickname.toLowerCase()}`;
  const existsNick = await NICKMAP.get(nickKey);
  if(existsNick) return json({success:false,error:'昵称已存在'},409);
  // create user
  const id = crypto.randomUUID();
  const pwdhash = await sha256(password);
  const user = {id,nickname,passwordHash:pwdhash,createdAt:Date.now()};
  await USERS.put(`user:${id}`,JSON.stringify(user));
  await NICKMAP.put(nickKey,id);
  await IPMAP.put(ipKey,id);
  return json({success:true,user:{id,nickname}});
}

async function loginHandler(body){
  const {nickname,password} = body||{};
  if(!nickname||!password) return json({success:false,error:'昵称和密码必填'},400);
  const nickKey = `nick:${nickname.toLowerCase()}`;
  const id = await NICKMAP.get(nickKey);
  if(!id) return json({success:false,error:'用户不存在'},404);
  const utext = await USERS.get(`user:${id}`);
  if(!utext) return json({success:false,error:'用户不存在'},404);
  const user = JSON.parse(utext);
  const ph = await sha256(password);
  if(ph !== user.passwordHash) return json({success:false,error:'密码错误'},401);
  const token = (await cryptoRandomString(32));
  await SESSIONS.put(`sess:${token}`,id,{expirationTtl:60*60*24});
  return json({success:true,token,user:{id:user.id,nickname:user.nickname}});
}

async function auth(request){
  const h = request.headers.get('Authorization')||'';
  if(!h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  const id = await SESSIONS.get(`sess:${token}`);
  if(!id) return null;
  const utext = await USERS.get(`user:${id}`);
  if(!utext) return null;
  return JSON.parse(utext);
}

async function createChatHandler(user,body){
  const participants = (body.participants||[]).map(n=>n.toLowerCase());
  if(!Array.isArray(participants) && typeof body.participants === 'string'){
    // allow comma-separated
    participants = body.participants.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  }
  if(!participants || participants.length<2 || participants.length>5) return json({success:false,error:'参与者数量需 2~5'},400);
  // resolve nicknames to ids
  const ids=[];
  for(const nick of participants){
    const id = await NICKMAP.get(`nick:${nick}`);
    if(!id) return json({success:false,error:`找不到用户 ${nick}`},404);
    ids.push(id);
  }
  if(!ids.includes(user.id)) ids.push(user.id);
  const chatId = crypto.randomUUID();
  const chat = {id:chatId,participants:ids,createdAt:Date.now()};
  await CHATS.put(`chat:${chatId}`,JSON.stringify(chat));
  // index into each user's chat list
  for(const uid of ids){
    const key = `user_chats:${uid}`;
    const text = await CHATS.get(key);
    const arr = text?JSON.parse(text):[];
    if(!arr.includes(chatId)) arr.push(chatId);
    await CHATS.put(key,JSON.stringify(arr));
  }
  return json({success:true,chat});
}

async function postMessageHandler(user,chatId,body){
  const text = (body.text||'').trim();
  if(!text) return json({success:false,error:'消息为空'},400);
  const ctext = await CHATS.get(`chat:${chatId}`);
  if(!ctext) return json({success:false,error:'会话不存在'},404);
  const chat = JSON.parse(ctext);
  if(!chat.participants.includes(user.id)) return json({success:false,error:'不在该会话中'},403);
  const msg = {id:crypto.randomUUID(),chatId, sender:user.id, senderNickname:user.nickname, text, ts:Date.now()};
  const key = `chat_msgs:${chatId}`;
  const old = await MESSAGES.get(key);
  const arr = old?JSON.parse(old):[];
  arr.push(msg);
  await MESSAGES.put(key,JSON.stringify(arr));
  return json({success:true,message:msg});
}

// simple helpers
async function sha256(str){
  const enc = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256',enc);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function cryptoRandomString(len){
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b=>b.toString(16).padStart(2,'0')).join('');
}
