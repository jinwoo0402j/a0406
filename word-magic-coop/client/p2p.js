// P2P 연결(WebRTC, PeerJS). 방장이 방 코드를 만들고 친구는 코드나 링크로 들어온다.
// 신호 교환(처음 연결 맺기)에만 PeerJS 공개 서버를 쓰고, 게임 데이터는 두 브라우저가 직접 주고받는다.
// PeerJS는 페이지가 <script>로 불러온 전역 Peer를 쓴다.

const PREFIX = 'wordmagic-coop-v1-';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 헷갈리는 글자(i, l, o, 0, 1) 제외
const JOIN_TIMEOUT_MS = 25000; // 중계(TURN)를 거치는 느린 연결까지 기다린다
const SILENCE_TIMEOUT_MS = 8000; // 호스트에서 이만큼 아무 메시지도 없으면 끊긴 것으로 본다
const PING_MS = 2000;

export const CODE_RE = /^[a-z2-9]{6}$/;

export function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

// 테스트용: 주소에 ?peer=host:port 를 붙이면 그 신호 서버를 쓴다. 기본은 PeerJS 공개 서버.
function peerOptions() {
  const q = new URLSearchParams(location.search).get('peer');
  const opts = { debug: 1 };
  if (q) {
    const [host, port] = q.split(':');
    Object.assign(opts, { host, port: Number(port) || 9000, path: '/', secure: false });
  }
  return opts;
}

function describe(err) {
  switch (err?.type) {
    case 'peer-unavailable': return '방을 찾을 수 없어요. 방장이 아직 방을 열어 두었는지, 코드가 맞는지 확인하세요.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed': return '연결 서버에 닿지 못했어요. 인터넷 연결을 확인하고 다시 시도하세요.';
    case 'browser-incompatible': return '이 브라우저는 P2P 연결(WebRTC)을 지원하지 않아요. 최신 Chrome·Edge·Firefox를 쓰세요.';
    case 'webrtc': return '상대와 직접 연결하지 못했어요. 회사·학교 등 보안이 엄격한 네트워크에서는 막힐 수 있어요.';
    default: return `연결 오류: ${err?.type || err?.message || '알 수 없음'}`;
  }
}

function needPeer() {
  if (!window.Peer) throw new Error('P2P 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침하세요.');
  return window.Peer;
}

// 방 만들기: session(HostSession)에 원격 참가자를 붙인다.
export function hostRoom(session, { onReady, onError }) {
  const Peer = needPeer();
  let attempts = 0;
  let peer;
  const open = () => {
    const code = makeCode();
    peer = new Peer(PREFIX + code, peerOptions());
    peer.on('open', () => onReady({ code }));
    peer.on('connection', (conn) => {
      let link = null;
      conn.on('open', () => {
        link = session.attachRemote({
          send: (obj) => { if (conn.open) conn.send(obj); },
          close: () => conn.close(),
        });
      });
      conn.on('data', (d) => link?.receive(d));
      conn.on('close', () => link?.closed());
      conn.on('error', () => link?.closed());
    });
    peer.on('disconnected', () => {
      // 신호 서버와의 연결만 끊긴 것: 진행 중인 게임 연결은 유지되고, 새 참가를 위해 다시 붙는다.
      if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch { /* 무시 */ } }, 1000);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && attempts++ < 3) {
        peer.destroy();
        open();
        return;
      }
      if (err.type === 'peer-unavailable') return;
      onError(describe(err));
    });
  };
  open();
  return { close: () => peer?.destroy() };
}

// 방 참가: WebSocket 연결과 같은 모양({ send, close })을 돌려준다.
export function joinRoom(code, onMessage, { onFail, onClose }) {
  const Peer = needPeer();
  const peer = new Peer(peerOptions());
  let conn = null;
  let opened = false;
  let done = false;
  let lastMsg = performance.now();
  const timers = [];
  const finish = (fn, arg) => {
    if (done) return;
    done = true;
    timers.forEach(clearInterval);
    try { peer.destroy(); } catch { /* 무시 */ }
    fn(arg);
  };
  timers.push(setTimeout(() => { if (!opened) finish(onFail, '방에 연결하지 못했어요(시간 초과). 코드와 인터넷 연결을 확인하세요.'); }, JOIN_TIMEOUT_MS));
  peer.on('open', () => {
    conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    conn.on('open', () => {
      opened = true;
      lastMsg = performance.now();
      timers.push(setInterval(() => { if (conn.open) conn.send({ t: 'ping' }); }, PING_MS));
      timers.push(setInterval(() => { if (performance.now() - lastMsg > SILENCE_TIMEOUT_MS) finish(onClose); }, 1000));
    });
    conn.on('data', (d) => {
      lastMsg = performance.now();
      onMessage(d);
    });
    conn.on('close', () => finish(opened ? onClose : onFail, '방장이 연결을 받지 않았어요.'));
    conn.on('error', () => finish(opened ? onClose : onFail, '방에 연결하지 못했어요.'));
  });
  peer.on('error', (err) => finish(opened ? onClose : onFail, describe(err)));
  return {
    send: (obj) => { if (conn?.open) conn.send(obj); },
    close: () => finish(() => {}),
  };
}
