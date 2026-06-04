// 简单客户端逻辑，使用 REST poll 方式
const api = {
  register: '/api/register',
  login: '/api/login',
  createChat: '/api/chats',
};

let token = localStorage.getItem('ll_token') || null;
let me = null;
let currentChat = null;
let pollInterval = null;

function $(id){return document.getElementById(id)}

async function apiPost(url, data){
  const res = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json','Authorization': token?`Bearer ${token}`:''},body:JSON.stringify(data)});
  return res.json();
}

async function apiGet(url){
  const res = await fetch(url, {headers:{'Authorization': token?`Bearer ${token}`:''}});
  return res.json();
}

async function register(){
  const nick = $('reg_nick').value.trim();
  const pwd = $('reg_pwd').value;
  if(!nick||!pwd){$('auth_msg').innerText='请输入昵称和密码';return}
  const r = await apiPost(api.register,{nickname:nick,password:pwd});
  if(r.success){$('auth_msg').innerText='注册成功,请登录';}else{$('auth_msg').innerText=r.error}
}

async function login(){
  const nick = $('login_nick').value.trim();
  const pwd = $('login_pwd').value;
  if(!nick||!pwd){$('auth_msg').innerText='请输入昵称和密码';return}
  const r = await apiPost(api.login,{nickname:nick,password:pwd});
  if(r.success){token=r.token;localStorage.setItem('ll_token',token);me=r.user;showChatUI();startPoll();}else{$('auth_msg').innerText=r.error}
}

function showChatUI(){
  $('auth').style.display='none';
  $('chat_ui').style.display='block';
  $('me').innerText = `我：${me.nickname} (ID:${me.id})`;
  loadChats();
}

async function loadChats(){
  const r = await apiGet('/api/chats');
  if(r.success){
    const ul = $('chats');ul.innerHTML='';
    r.chats.forEach(c=>{
      const li = document.createElement('li');
      li.innerText = `${c.id} — 人数:${c.participants.length}`;
      li.onclick = ()=>openChat(c.id);
      ul.appendChild(li);
    });
  }
}

async function createChat(){
  const raw = $('participants').value.trim();
  if(!raw){$('create_msg').innerText='请输入参与者昵称'}
  const names = raw.split(',').map(s=>s.trim()).filter(Boolean);
  if(names.length<2||names.length>5){$('create_msg').innerText='参与者数量需 2~5';return}
  const r = await apiPost(api.createChat,{participants:names});
  if(r.success){$('create_msg').innerText='创建成功';loadChats();}else{$('create_msg').innerText=r.error}
}

async function openChat(id){
  currentChat=id;$('chat_title').innerText='消息 - '+id;$('messages_box').innerHTML='';
  const r = await apiGet(`/api/chats/${id}/messages`);
  if(r.success){r.messages.forEach(appendMessage)}
}

function appendMessage(m){
  const box = $('messages_box');
  const d = document.createElement('div');d.className='message';
  d.innerText = `${m.senderNickname}: ${m.text}`;
  box.appendChild(d);box.scrollTop = box.scrollHeight;
}

async function sendMessage(){
  const txt = $('msg_input').value.trim();if(!txt||!currentChat)return;
  const r = await apiPost(`/api/chats/${currentChat}/messages`,{text:txt});
  if(r.success){$('msg_input').value='';appendMessage(r.message)}else{alert(r.error||'发送失败')}
}

async function poll(){
  if(!currentChat) return;
  const r = await apiGet(`/api/chats/${currentChat}/messages`);
  if(r.success){$('messages_box').innerHTML='';r.messages.forEach(appendMessage)}
}

function startPoll(){ if(pollInterval) clearInterval(pollInterval); pollInterval=setInterval(poll,2000); }

function logout(){localStorage.removeItem('ll_token');token=null;location.reload();}

// bind events
$('btn_register').onclick=register;
$('btn_login').onclick=login;
$('btn_create_chat').onclick=createChat;
$('btn_send').onclick=sendMessage;
$('btn_logout').onclick=logout;

// if token exists, try to get profile
(async ()=>{
  if(token){
    const r = await apiGet('/api/me');
    if(r.success){me=r.user;showChatUI();startPoll();}else{localStorage.removeItem('ll_token')}
  }
})();
