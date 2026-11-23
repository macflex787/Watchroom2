import {initializeApp} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {getAuth,signInAnonymously,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {getDatabase,ref,set,get,push,onValue,onChildAdded,remove,onDisconnect,serverTimestamp,limitToLast,query,update} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
const $=id=>document.getElementById(id);const config=window.WATCHROOM_FIREBASE_CONFIG;
let auth,db,uid,roomId,hostId,displayName,participants={},off=[],voiceStream=null,muted=false;
let activeMediaKey=null, playbackState=null, mediaLoading=false, lastHostPublish=0, syncTimer=null, syncOptOut=false, guestLocalPaused=false, syncActionDepth=0;
const mediaConfig=window.WATCHROOM_MEDIA_CONFIG||{};let subtitleBlobUrl=null;
const peers=new Map(),remoteAudio=new Map(),processedSignals=new Set();
const show=(id,yes)=>$(id).classList.toggle('hidden',!yes);
const error=(id,msg)=>$(id).textContent=msg||'';
function randomId(){const b=new Uint8Array(18);crypto.getRandomValues(b);return [...b].map(v=>v.toString(16).padStart(2,'0')).join('');}
function driveId(url){try{const u=new URL(url);if(!['drive.google.com','docs.google.com'].includes(u.hostname))return null;let m=u.pathname.match(/\/file\/d\/([\w-]+)/);if(m)return m[1];const id=u.searchParams.get('id');return id&&/^[\w-]{10,}$/.test(id)?id:null;}catch{return null}}
function saveName(){displayName=$('displayName').value.trim().slice(0,30)||localStorage.getItem('watchroom-name')||'Guest';localStorage.setItem('watchroom-name',displayName);}
function setStatus(msg){$('connection').textContent='● '+msg;}
async function init(){if(!config||!config.apiKey||config.apiKey==='REPLACE_ME'){error('setupError','Fill in config.js to enable the app.');return;}try{const app=initializeApp(config);auth=getAuth(app);db=getDatabase(app);await signInAnonymously(auth);uid=auth.currentUser.uid;show('setup',false);show('lobby',true);setStatus('Connected');$('displayName').value=localStorage.getItem('watchroom-name')||'';const id=new URLSearchParams(location.search).get('room');if(id){if(!/^[a-f0-9]{36}$/.test(id))throw Error('Invalid room link');await joinRoom(id);} }catch(e){error('setupError','Firebase setup or connection failed: '+e.message);error('lobbyError',e.message);setStatus('Connection error');}}
async function joinRoom(id){saveName();const snap=await get(ref(db,`rooms/${id}/meta`));if(!snap.exists())throw Error('Room not found or expired.');roomId=id;hostId=snap.val().hostId;const presence=ref(db,`rooms/${id}/participants/${uid}`);await onDisconnect(presence).remove();await set(presence,{name:displayName,joinedAt:serverTimestamp()});show('lobby',false);show('room',true);$('roomShort').textContent='#'+id.slice(0,6);for(const id of ['setVideo','driveUrl','sourceMode','r2File','uploadSecret','retentionHours','uploadR2','directUrl','setDirect','subtitleFile','subtitleUrl','setSubtitle','clearSubtitle'])$(id).disabled=uid!==hostId;$('videoNote').textContent=uid===hostId?'You are the host. Select a media source.':'Only the host can change the media.';
 off.push(onValue(ref(db,`rooms/${id}/video`),s=>renderMedia(s.val()).catch(e=>error('videoError',e.message))));
 off.push(onValue(ref(db,`rooms/${id}/playback`),s=>{playbackState=s.val();applyPlaybackSync();}));
 off.push(onValue(ref(db,`rooms/${id}/subtitle`),s=>renderSubtitle(s.val())));
 off.push(onValue(ref(db,`rooms/${id}/participants`),s=>{participants=s.val()||{};const list=$('people');list.replaceChildren();Object.entries(participants).forEach(([id,p])=>{const li=document.createElement('li'),dot=document.createElement('span');dot.className='dot';li.append(dot,document.createTextNode((p.name||'Guest')+(id===hostId?' (host)':'')+(id===uid?' (you)':'')));list.append(li);});$('count').textContent=Object.keys(participants).length;if(voiceStream)syncPeers();}));
 off.push(onChildAdded(query(ref(db,`rooms/${id}/messages`),limitToLast(100)),s=>{const m=s.val();if(!m)return;const el=document.createElement('div');el.className='message';const head=document.createElement('div'),who=document.createElement('span'),when=document.createElement('span'),body=document.createElement('div');who.className='who';who.textContent=m.name||'Guest';when.className='when';when.textContent=m.at?new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'';body.className='body';body.textContent=m.text||'';head.append(who,when);el.append(head,body);$('messages').append(el);while($('messages').children.length>100)$('messages').firstChild.remove();$('messages').scrollTop=$('messages').scrollHeight;}));
 off.push(onChildAdded(ref(db,`rooms/${id}/signals/${uid}`),async s=>{if(processedSignals.has(s.key))return;processedSignals.add(s.key);try{await handleSignal(s.val());}catch(e){console.warn('Voice signaling error',e);}finally{remove(s.ref).catch(()=>{});}}));
 history.replaceState(null,'',`${location.pathname}?room=${id}`);
}
async function createRoom(){error('lobbyError','');saveName();try{const id=randomId();await set(ref(db,`rooms/${id}/meta`),{hostId:uid,createdAt:serverTimestamp()});await joinRoom(id);}catch(e){error('lobbyError',e.message);}}
async function loadVideo(){error('videoError','');const url=$('driveUrl').value.trim(),fileId=driveId(url);if(!fileId){error('videoError','Use a valid Google Drive file sharing link.');return;}try{await set(ref(db,`rooms/${roomId}/video`),{fileId,url,updatedAt:serverTimestamp()});}catch(e){error('videoError',e.message);}}
async function sendSignal(to,data){if(!roomId)return;await push(ref(db,`rooms/${roomId}/signals/${to}`),{...data,from:uid});}
function peerFor(id){if(peers.has(id))return peers.get(id);const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});peers.set(id,pc);voiceStream?.getTracks().forEach(t=>pc.addTrack(t,voiceStream));pc.onicecandidate=e=>{if(e.candidate)sendSignal(id,{type:'ice',candidate:e.candidate.toJSON()}).catch(console.warn)};pc.ontrack=e=>{let audio=remoteAudio.get(id);if(!audio){audio=document.createElement('audio');audio.autoplay=true;audio.playsInline=true;document.body.append(audio);remoteAudio.set(id,audio);}audio.srcObject=e.streams[0];audio.play().catch(()=>{});};pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState)){$('voiceStatus').textContent='Voice: connection '+pc.connectionState;}};return pc;}
async function offer(id){const pc=peerFor(id);const desc=await pc.createOffer();await pc.setLocalDescription(desc);await sendSignal(id,{type:'offer',sdp:pc.localDescription.toJSON()});}
async function handleSignal(s){if(!s||!s.from||s.from===uid)return;if(s.type==='bye'){closePeer(s.from);return;}if(s.type==='voice-ready'){if(voiceStream&&uid>s.from)await offer(s.from);return;}if(!voiceStream)return;const pc=peerFor(s.from);if(s.type==='offer'){if(pc.signalingState!=='stable'){await pc.setLocalDescription({type:'rollback'});}await pc.setRemoteDescription(s.sdp);await pc.setLocalDescription(await pc.createAnswer());await sendSignal(s.from,{type:'answer',sdp:pc.localDescription.toJSON()});}else if(s.type==='answer'){if(pc.signalingState==='have-local-offer')await pc.setRemoteDescription(s.sdp);}else if(s.type==='ice'){try{await pc.addIceCandidate(s.candidate)}catch(e){console.warn('ICE candidate could not be added',e)}}}
async function syncPeers(){if(!voiceStream)return;for(const id of Object.keys(participants)){if(id!==uid&&!peers.has(id)&&uid<id)await sendSignal(id,{type:'voice-ready'});}for(const id of [...peers.keys()])if(!participants[id])closePeer(id);}
async function joinVoice(){try{voiceStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});$('joinVoice').disabled=true;$('muteVoice').disabled=false;$('leaveVoice').disabled=false;$('voiceStatus').textContent='Voice connected';for(const id of Object.keys(participants))if(id!==uid)await sendSignal(id,{type:'voice-ready'});}catch(e){$('voiceStatus').textContent='Mic unavailable: '+e.message;}}
function closePeer(id){peers.get(id)?.close();peers.delete(id);remoteAudio.get(id)?.remove();remoteAudio.delete(id);}
async function leaveVoice(){for(const id of peers.keys())sendSignal(id,{type:'bye'}).catch(()=>{});for(const id of [...peers.keys()])closePeer(id);voiceStream?.getTracks().forEach(t=>t.stop());voiceStream=null;muted=false;$('joinVoice').disabled=false;$('muteVoice').disabled=true;$('muteVoice').textContent='Mute mic';$('leaveVoice').disabled=true;$('voiceStatus').textContent='Voice disconnected';}
async function leaveRoom(){if(syncTimer){clearInterval(syncTimer);syncTimer=null;}activeMediaKey=null;playbackState=null;syncOptOut=false;guestLocalPaused=false;await leaveVoice();off.forEach(f=>f());off=[];if(roomId){await remove(ref(db,`rooms/${roomId}/participants/${uid}`)).catch(()=>{});}roomId=null;participants={};processedSignals.clear();$('messages').replaceChildren();show('room',false);show('lobby',true);history.replaceState(null,'',location.pathname);}
$('createRoom').onclick=createRoom;$('setVideo').onclick=loadVideo;$('copyInvite').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);$('copyInvite').textContent='Copied!';setTimeout(()=>$('copyInvite').textContent='Copy invite link',1800);}catch{prompt('Copy this link:',location.href)}};$('leaveRoom').onclick=leaveRoom;
$('chatForm').onsubmit=async e=>{e.preventDefault();const input=$('messageInput'),msg=input.value.trim();if(!msg||!roomId)return;input.value='';try{await push(ref(db,`rooms/${roomId}/messages`),{name:displayName,text:msg.slice(0,1000),at:Date.now(),sender:uid});}catch(err){input.value=msg;alert('Message not sent: '+err.message);}};
$('joinVoice').onclick=joinVoice;$('leaveVoice').onclick=leaveVoice;$('muteVoice').onclick=()=>{muted=!muted;voiceStream?.getAudioTracks().forEach(t=>t.enabled=!muted);$('muteVoice').textContent=muted?'Unmute mic':'Mute mic';};

function validHttps(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password)throw Error();return u.href;}catch{throw Error('A valid public HTTPS URL is required.');}}
// Host-authoritative playback synchronization (R2 and direct HTTPS only).
function mediaIdentity(v){return v&&(v.mode==='r2'?`r2:${v.key}`:v.mode==='url'?`url:${v.url}`:null);}
function activePlayer(){return !$('directPlayer').classList.contains('hidden')?$('directPlayer'):!$('audioPlayer').classList.contains('hidden')?$('audioPlayer'):null;}
function syncLabel(message){const el=$('syncStatus');if(el)el.textContent=message;}
function updateLocalPauseButton(){
 const btn=$('localPausePlayback');if(!btn)return;
 const available=uid!==hostId&&!!activeMediaKey&&!syncOptOut;
 show('localPausePlayback',available);
 btn.textContent=guestLocalPaused?'Resume with host':'Pause for me';
 btn.setAttribute('aria-pressed',String(guestLocalPaused));
}
function updateJoinButton(visible){
 const btn=$('joinPlayback');if(btn){show('joinPlayback',visible&&uid!==hostId&&!!activeMediaKey);btn.textContent=syncOptOut?'Rejoin synchronization':'Join synchronized playback';}
 const cancel=$('cancelPlaybackSync');if(cancel)show('cancelPlaybackSync',uid!==hostId&&!!activeMediaKey&&!syncOptOut);
 updateLocalPauseButton();
}
// Suppress events caused by synchronization itself, not by the viewer pressing native controls.
function syncedPlayerAction(action){
 syncActionDepth++;
 try{return action();}finally{setTimeout(()=>{syncActionDepth=Math.max(0,syncActionDepth-1);},0);}
}
function localPause(){
 if(uid===hostId||syncOptOut||!activeMediaKey)return;
 guestLocalPaused=true;
 const player=activePlayer();if(player&&!player.paused)syncedPlayerAction(()=>player.pause());
 syncLabel('Paused for you — host keeps playing');updateJoinButton(false);
}
function resumeWithHost(){
 if(uid===hostId||syncOptOut||!activeMediaKey)return;
 guestLocalPaused=false;updateJoinButton(false);
 syncLabel('Rejoining host playback…');applyPlaybackSync();
}
function cancelPlaybackSync(){syncOptOut=true;guestLocalPaused=false;syncLabel('Sync off — independent playback');updateJoinButton(true);}
$('cancelPlaybackSync').addEventListener('click',cancelPlaybackSync);
$('localPausePlayback').addEventListener('click',()=>guestLocalPaused?resumeWithHost():localPause());
function targetPosition(state){return Math.max(0,Number(state.position)||0)+(state.playing?Math.max(0,(Date.now()-Number(state.updatedAt||Date.now()))/1000):0);}
async function publishPlayback(){
 if(uid!==hostId||!roomId||!activeMediaKey||mediaLoading)return;
 const player=activePlayer();if(!player||!Number.isFinite(player.currentTime))return;
 const state={mediaKey:activeMediaKey,position:player.currentTime,playing:!player.paused&&!player.ended,updatedAt:Date.now()};
 try{await set(ref(db,`rooms/${roomId}/playback`),state);}catch(e){syncLabel('Sync update failed: '+e.message);}
}
function applyPlaybackSync(){
 if(!roomId||uid===hostId||!activeMediaKey||syncOptOut)return;
 if(guestLocalPaused){syncLabel('Paused for you — host keeps playing');return;}
 const player=activePlayer(),state=playbackState;
 if(!player||!state||state.mediaKey!==activeMediaKey||player.readyState===0)return;
 let target=targetPosition(state);
 if(Number.isFinite(player.duration))target=Math.min(target,Math.max(0,player.duration-0.15));
 if(Math.abs(player.currentTime-target)>(state.playing?1.5:0.3)){
  try{syncedPlayerAction(()=>{player.currentTime=target;});}catch(e){console.warn('Sync seek delayed',e);}
 }
 if(state.playing){
  if(player.paused)syncedPlayerAction(()=>player.play()).then(()=>{if(!guestLocalPaused){syncLabel('Synchronized with host');updateJoinButton(false);}}).catch(()=>{if(!guestLocalPaused){syncLabel('Tap Join synchronized playback to start');updateJoinButton(true);}});
  else syncLabel('Synchronized with host');
 }else{if(!player.paused)syncedPlayerAction(()=>player.pause());syncLabel('Host paused playback');updateJoinButton(false);}
}
for(const player of [$('directPlayer'),$('audioPlayer')]){
 player.addEventListener('loadedmetadata',()=>{if(uid===hostId){mediaLoading=false;}else applyPlaybackSync();});
 for(const eventName of ['play','pause','seeked'])player.addEventListener(eventName,()=>{
  if(uid===hostId){if(!mediaLoading)publishPlayback();return;}
  if(!roomId||!activeMediaKey||syncOptOut||syncActionDepth)return;
  if(eventName==='pause'&&playbackState?.playing&&!guestLocalPaused){localPause();}
  if(eventName==='play'&&guestLocalPaused){resumeWithHost();}
 });
 player.addEventListener('timeupdate',()=>{if(uid===hostId&&!mediaLoading&&!player.paused&&Date.now()-lastHostPublish>5000){lastHostPublish=Date.now();publishPlayback();}});
}
$('joinPlayback').addEventListener('click',async()=>{
 syncOptOut=false;guestLocalPaused=false;updateJoinButton(false);
 const player=activePlayer();if(!player)return;
 try{await syncedPlayerAction(()=>player.play());applyPlaybackSync();if(playbackState&&!playbackState.playing)syncedPlayerAction(()=>player.pause());updateJoinButton(false);}catch(e){syncLabel('Playback blocked: '+e.message);}
});
function modeChange(){const m=$('sourceMode').value;show('r2Fields',m==='r2');show('driveFields',m==='drive');show('urlFields',m==='url');}
$('sourceMode').addEventListener('change',modeChange);
async function renderMedia(v){const nextKey=mediaIdentity(v);if(nextKey!==activeMediaKey){syncOptOut=false;guestLocalPaused=false;activeMediaKey=nextKey;mediaLoading=!!nextKey;syncLabel(nextKey?(uid===hostId?'Host controls playback':'Waiting for host playback…'):'');updateJoinButton(false);}
 const frame=$('videoFrame'),video=$('directPlayer'),audio=$('audioPlayer');frame.removeAttribute('src');video.pause();audio.pause();video.removeAttribute('src');audio.removeAttribute('src');video.load();audio.load();frame.style.display='none';show('directPlayer',false);show('audioPlayer',false);show('emptyPlayer',!v);if(!v)return;
 if(v.mode==='drive'||(!v.mode&&v.fileId)){frame.src=`https://drive.google.com/file/d/${encodeURIComponent(v.fileId)}/preview`;frame.style.display='block';show('emptyPlayer',false);return;}
 if(v.mode==='r2'||v.mode==='url'){let url=v.mode==='r2'?`${mediaConfig.workerUrl?.replace(/\/$/,'')}/media/${encodeURIComponent(v.key)}`:validHttps(v.url);if(!url||url.startsWith('undefined'))throw Error('Configure media-config.js with the R2 Worker URL.');const isAudio=/\.(mp3|m4a|ogg|wav|flac)(?:$|[?#])/i.test(v.filename||v.url||'');const player=isAudio?audio:video;player.src=url;show(isAudio?'audioPlayer':'directPlayer',true);show('emptyPlayer',false);player.controls=true;player.load();if(uid!==hostId){updateJoinButton(true);}if(!syncTimer){syncTimer=setInterval(applyPlaybackSync,4000);}return;}}
function srtToVtt(s){const normalized=s.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2');return 'WEBVTT\n\n'+normalized.replace(/^WEBVTT\s*/i,'');}
function renderSubtitle(v){const player=$('directPlayer');player.querySelectorAll('track').forEach(t=>t.remove());if(subtitleBlobUrl){URL.revokeObjectURL(subtitleBlobUrl);subtitleBlobUrl=null;}if(!v)return;let url;if(v.key){if(!mediaConfig.workerUrl)return;url=`${mediaConfig.workerUrl.replace(/\/$/,'')}/media/${encodeURIComponent(v.key)}`;}else if(v.url){try{url=validHttps(v.url);}catch{return;}}else return;
 // Browser track loading requires CORS from the media origin.
 const track=document.createElement('track');track.kind='subtitles';track.label=v.label||'Subtitles';track.srclang=v.lang||'en';track.src=url;track.default=true;player.append(track);track.addEventListener('load',()=>{track.track.mode='showing';});}
const MULTIPART_CHUNK=8*1024*1024;
async function uploadToWorker(file){
 const base=mediaConfig.workerUrl?.replace(/\/$/,'');if(!base)throw Error('Set workerUrl in media-config.js first.');
 const secret=$('uploadSecret').value;if(!secret)throw Error('Enter the Worker upload password.');
 if(!file.size||file.size>5*1024**3)throw Error('Choose a nonempty file no larger than 5 GiB.');
 const key=`${crypto.randomUUID()}/${file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,180)||'movie.bin'}`;
 const hours=Number($('retentionHours').value);
  if(![6,12,24,168,336,504,672].includes(hours))throw Error('Choose a valid retention period.');
  const auth={'Authorization':`Bearer ${secret}`};
 const check=async res=>{if(!res.ok)throw Error('Upload failed: '+res.status+' '+(await res.text()).slice(0,180));return res.json();};
 const progress=$('uploadProgress');progress.value=0;show('uploadProgress',true);
 if(file.size<=90*1024*1024){
  const res=await fetch(`${base}/upload/${encodeURIComponent(key)}`,{method:'PUT',headers:{...auth,'Content-Type':file.type||'application/octet-stream','X-Watchroom-Retention-Hours':String(hours)},body:file});await check(res);progress.value=100;return key;
 }
 const init=await check(await fetch(`${base}/multipart/init`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({key,size:file.size,contentType:file.type||'application/octet-stream',retentionHours:hours})}));
 const query=`key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(init.uploadId)}`;
 const parts=[];const count=Math.ceil(file.size/MULTIPART_CHUNK);
 try{
  for(let i=0;i<count;i++){
   const chunk=file.slice(i*MULTIPART_CHUNK,Math.min((i+1)*MULTIPART_CHUNK,file.size));
   let part,err;
   for(let attempt=0;attempt<3;attempt++){
    try{part=await check(await fetch(`${base}/multipart/part?${query}&partNumber=${i+1}`,{method:'PUT',headers:{...auth,'Content-Type':'application/octet-stream'},body:chunk}));break;}
    catch(e){err=e;if(attempt<2)await new Promise(r=>setTimeout(r,800*(attempt+1)));}
   }
   if(!part)throw err;
   parts.push(part);progress.value=Math.round((i+1)/count*100);
   $('uploadStatus').textContent=`Uploading part ${i+1} of ${count} (${progress.value}%)`;
  }
  $('uploadStatus').textContent='Finalizing movie in R2…';
  await check(await fetch(`${base}/multipart/complete?${query}`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({parts})}));
  progress.value=100;return key;
 }catch(e){await fetch(`${base}/multipart/abort?${query}`,{method:'POST',headers:auth}).catch(()=>{});throw e;}
}
$('uploadR2').onclick=async()=>{error('videoError','');const file=$('r2File').files[0];if(!file){error('videoError','Select a file first.');return;}$('uploadR2').disabled=true;$('uploadStatus').textContent='Uploading… (large files can take time)';try{const key=await uploadToWorker(file);await set(ref(db,`rooms/${roomId}/video`),{mode:'r2',key,filename:file.name,updatedAt:serverTimestamp()});await set(ref(db,`rooms/${roomId}/playback`),{mediaKey:`r2:${key}`,position:0,playing:false,updatedAt:Date.now()});$('uploadStatus').textContent='Uploaded. Friends can play now.';}catch(e){error('videoError',e.message);$('uploadStatus').textContent='Upload not completed.';}finally{$('uploadR2').disabled=uid!==hostId;}};
$('setDirect').onclick=async()=>{try{error('videoError','');const url=validHttps($('directUrl').value);await set(ref(db,`rooms/${roomId}/video`),{mode:'url',url,filename:new URL(url).pathname,updatedAt:serverTimestamp()});await set(ref(db,`rooms/${roomId}/playback`),{mediaKey:`url:${url}`,position:0,playing:false,updatedAt:Date.now()});}catch(e){error('videoError',e.message);}};
$('setSubtitle').onclick=async()=>{try{error('videoError','');const file=$('subtitleFile').files[0];if(file){if(file.size>2*1024*1024)throw Error('Subtitle file too large (2 MiB max).');let contents=await file.text();if(/\.srt$/i.test(file.name))contents=srtToVtt(contents);else if(!contents.trimStart().startsWith('WEBVTT'))throw Error('Select an SRT or VTT file.');const blob=new File([contents],file.name.replace(/\.srt$/i,'.vtt'),{type:'text/vtt'});const key=await uploadToWorker(blob);await set(ref(db,`rooms/${roomId}/subtitle`),{key,label:file.name,lang:'en'});}else{const url=validHttps($('subtitleUrl').value);if(!/\.vtt(?:$|[?#])/i.test(url))throw Error('External subtitle URL must be WebVTT (.vtt).');await set(ref(db,`rooms/${roomId}/subtitle`),{url,label:'Subtitles',lang:'en'});}}catch(e){error('videoError',e.message);}};
$('clearSubtitle').onclick=()=>remove(ref(db,`rooms/${roomId}/subtitle`)).catch(e=>error('videoError',e.message));

init();
