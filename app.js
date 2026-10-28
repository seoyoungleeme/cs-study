'use strict';

/* ============================ 상태 ============================ */
const LS_PROGRESS = 'csq.progress.v1';
const LS_CONFIG   = 'csq.config.v1';
const DAY = 86400e3;

const DEFAULT_CONFIG = {
  newPerDay: 8,
  maxPerDay: 60,
  cats: null,            // null = 전체. 배열이면 해당 slug 만.
  mode: 'write',         // write | choice | mix
  provider: 'none',
  key: '',
  model: '',
  url: '',
};

const DEFAULT_MODEL = {
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
  custom: 'llama3.1',
};

let QUESTIONS = [];
let CATS = [];
let BY_ID = new Map();
const ANSWER_CACHE = new Map();   // slug -> {id: {...}}
const PENDING = new Map();        // slug -> Promise

let progress = load(LS_PROGRESS, {cards: {}, log: {}});
let config   = Object.assign({}, DEFAULT_CONFIG, load(LS_CONFIG, {}));

let MCQ = new Set();   // 선택지가 준비된 문항 id
let queue = [];        // 이번 세션에 풀 카드 id
let asChoice = false;  // 지금 카드를 객관식으로 낼지
let answered = false;  // 객관식 선택을 이미 했는지
let current = null;    // 현재 질문 객체
let revealed = false;

/* ============================ 유틸 ============================ */
function load(k, fallback){
  try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; }
  catch { return fallback; }
}
function save(k, v){
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch(e){ toast('저장 실패: 저장 공간이 가득 찼습니다'); }
}
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const todayKey = () => new Date().toISOString().slice(0,10);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let toastTimer;
function toast(msg, ms=2200){
  const t = $('#toast');
  t.innerHTML = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('on'), ms);
}

/* 아주 작은 마크다운 렌더러. 답변 JSON 은 우리가 만든 것이지만 일단 이스케이프한다. */
function md(src){
  const lines = esc(src).split('\n');
  let html = '', inUl = false, inPre = false, buf = [];
  const closeUl = () => { if (inUl){ html += '</ul>'; inUl = false; } };
  for (const raw of lines){
    if (raw.trimStart().startsWith('```')){
      if (inPre){ html += '<pre><code>' + buf.join('\n') + '</code></pre>'; buf = []; inPre = false; }
      else { closeUl(); inPre = true; }
      continue;
    }
    if (inPre){ buf.push(raw); continue; }
    const line = raw.trim();
    if (!line){ closeUl(); continue; }
    const h = /^(#{3,4})\s+(.*)$/.exec(line);
    if (h){ closeUl(); html += '<h4>' + inline(h[2]) + '</h4>'; continue; }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li){ if (!inUl){ html += '<ul>'; inUl = true; } html += '<li>' + inline(li[1]) + '</li>'; continue; }
    closeUl();
    html += '<p>' + inline(line) + '</p>';
  }
  if (inPre) html += '<pre><code>' + buf.join('\n') + '</code></pre>';
  closeUl();
  return html;
}
function inline(s){
  return s.replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/* ============================ SRS ============================ */
/* SM-2 를 3버튼으로 줄인 것. 0=모름 1=애매 2=앎 */
function newCard(){ return {ef:2.5, iv:0, due:0, reps:0, lapses:0, seen:0}; }

function schedule(card, g){
  const now = Date.now();
  card.seen = now;
  if (g === 0){
    card.lapses++; card.reps = 0;
    card.ef = Math.max(1.3, card.ef - 0.2);
    card.iv = 0;
    card.due = now + 9 * 60e3;        // 같은 세션에서 다시 보도록 9분 뒤
  } else if (g === 1){
    card.ef = Math.max(1.3, card.ef - 0.05);
    card.iv = card.reps === 0 ? 1 : Math.max(1, Math.round(card.iv * 1.25));
    card.reps++;
    card.due = now + card.iv * DAY;
  } else {
    card.ef = Math.min(3.0, card.ef + 0.08);
    card.iv = card.reps === 0 ? 2 : card.reps === 1 ? 5 : Math.round(card.iv * card.ef);
    card.reps++;
    card.due = now + card.iv * DAY;
  }
  return card;
}
function nextLabel(card, g){
  const probe = schedule(Object.assign({}, card), g);
  if (g === 0) return '9분';
  return probe.iv >= 30 ? Math.round(probe.iv/30) + '개월'
       : probe.iv >= 1  ? probe.iv + '일' : '오늘';
}
function state(id){
  const c = progress.cards[id];
  if (!c || !c.seen) return 'new';
  return c.reps === 0 ? 'learn' : 'rev';
}
function catEnabled(slug){
  return !config.cats || config.cats.includes(slug);
}

/* ============================ 큐 ============================ */
function buildQueue(extra = 0){
  const now = Date.now();
  const day = todayKey();
  const done = progress.log[day] || {new:0, rev:0};

  const usable = id => config.mode !== 'choice' || MCQ.has(id);
  const due = [], fresh = [];
  for (const q of QUESTIONS){
    if (!usable(q.id)) continue;
    const c = progress.cards[q.id];
    if (c && c.seen){
      if (c.due <= now) due.push([c.due, q.id]);
    } else if (catEnabled(q.slug)){
      fresh.push(q.id);
    }
  }
  due.sort((a,b) => a[0] - b[0]);

  const revRoom = Math.max(0, config.maxPerDay - done.rev) + extra;
  const newRoom = Math.max(0, config.newPerDay - done.new) + (extra ? Math.ceil(extra/3) : 0);

  queue = due.slice(0, revRoom).map(x => x[1]);
  // 새 카드는 카테고리를 번갈아 섞어서 한 주제에만 몰리지 않게 한다
  const byCat = new Map();
  for (const id of fresh){
    const s = BY_ID.get(id).slug;
    if (!byCat.has(s)) byCat.set(s, []);
    byCat.get(s).push(id);
  }
  const lanes = Array.from(byCat.values());
  const picked = [];
  for (let i = 0; picked.length < newRoom && lanes.some(l => l.length); i++){
    for (const lane of lanes){
      if (picked.length >= newRoom) break;
      if (lane.length) picked.push(lane.shift());
    }
  }
  // 복습 먼저, 그 다음 새 카드 (지친 상태에서 새 개념을 만나지 않도록)
  queue = queue.concat(picked);
}

function bumpLog(id){
  const day = todayKey();
  const l = progress.log[day] || (progress.log[day] = {new:0, rev:0, graded:0});
  if (state(id) === 'new') l.new++; else l.rev++;
}

/* ============================ 답변 로딩 ============================ */
async function getAnswer(q){
  if (!ANSWER_CACHE.has(q.slug)){
    if (!PENDING.has(q.slug)){
      PENDING.set(q.slug, fetch(`data/answers/${q.slug}.json`)
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({}))
        .then(j => { ANSWER_CACHE.set(q.slug, j); PENDING.delete(q.slug); return j; }));
    }
    await PENDING.get(q.slug);
  }
  return ANSWER_CACHE.get(q.slug)[q.id] || null;
}
function prefetchNext(){
  const nxt = queue[1] && BY_ID.get(queue[1]);
  if (nxt) getAnswer(nxt);
}

/* ============================ 학습 화면 ============================ */
function renderQueueBar(){
  const day = todayKey();
  const done = progress.log[day] || {new:0, rev:0};
  $('#queue-count').textContent = queue.length ? `남은 카드 ${queue.length}개` : '';
  $('#queue-meta').textContent = `오늘 새 질문 ${done.new||0} · 복습 ${done.rev||0}`;
}

function showCard(){
  renderQueueBar();
  revealed = false;
  if (!queue.length){
    current = null;
    $('#card').classList.add('hidden');
    $('#empty').classList.remove('hidden');
    const total = QUESTIONS.length;
    const started = Object.values(progress.cards).filter(c => c.seen).length;
    const upcoming = Object.values(progress.cards)
      .filter(c => c.seen && c.due > Date.now())
      .sort((a,b) => a.due - b.due)[0];
    $('#empty-sub').innerHTML =
      `${started}/${total}개 시작함` +
      (upcoming ? ` · 다음 복습 ${fmtWhen(upcoming.due)}` : '');
    return;
  }
  $('#empty').classList.add('hidden');
  $('#card').classList.remove('hidden');

  current = BY_ID.get(queue[0]);
  const st = state(current.id);
  const card0 = progress.cards[current.id];
  // 섞기 모드에서는 같은 카드를 볼 때마다 서술형과 객관식을 번갈아 낸다
  asChoice = MCQ.has(current.id) && (config.mode === 'choice' ||
    (config.mode === 'mix' && ((card0 && card0.reps || 0) % 2 === 0)));
  answered = false;
  $('#c-cat').textContent = current.category;
  $('#c-sec').textContent = current.section;
  $('#c-id').textContent = current.id + (st === 'new' ? ' · 새 질문' : '');
  $('#c-q').textContent = current.question;
  $('#c-input').value = '';
  $('#c-input').classList.toggle('hidden', asChoice);
  $('#choices').classList.toggle('hidden', !asChoice);
  $('#choices').innerHTML = '';
  $('#recall-hint').textContent = asChoice
    ? '맞는 것을 고르세요.'
    : '머릿속으로 또는 소리 내어 답해보세요.';
  $('#answer').classList.add('hidden');
  $('#btn-more').classList.remove('hidden');
  $('#grade-box').classList.add('hidden');
  $('#grade-box').innerHTML = '';
  $('#btn-reveal').classList.toggle('hidden', asChoice);
  $('#btn-grade').classList.toggle('hidden', asChoice || config.provider === 'none');
  $('#btn-grade').disabled = false;
  $('#btn-grade').textContent = '채점';
  $('#recall-hint').classList.remove('hidden');
  window.scrollTo({top:0});
  if (asChoice) renderChoices();
  prefetchNext();
}

/* ============================ 객관식 ============================ */
async function renderChoices(){
  const q = current;
  const a = await getAnswer(q);
  if (!a || !a.choices){ asChoice = false; showCard(); return; }
  if (current !== q) return;                 // 로딩 중에 카드가 넘어갔으면 버린다

  $('#c-q').textContent = a.choices.q || q.question;

  // options[0] 이 정답. 매번 섞어 위치를 외우지 못하게 한다
  const opts = a.choices.options.map((text, i) => ({text, ok: i === 0}));
  for (let i = opts.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  $('#choices').innerHTML = opts.map((o, i) =>
    `<button class="opt" data-ok="${o.ok ? 1 : 0}">` +
    `<span class="mark">${'ABCD'[i]}</span><span>${inline(esc(o.text))}</span></button>`
  ).join('') + '<div id="choice-verdict" class="hidden"></div>';
}

async function pickChoice(btn){
  if (answered) return;
  answered = true;
  const ok = btn.dataset.ok === '1';
  $$('.opt').forEach(b => {
    b.disabled = true;
    if (b.dataset.ok === '1') b.classList.add('correct');
    else if (b === btn) b.classList.add('wrong');
    else b.classList.add('dim');
  });
  const v = $('#choice-verdict');
  const a = await getAnswer(current);
  v.className = ok ? 'ok' : 'no';
  v.textContent = (ok ? '정답' : '오답') + (a.choices.why ? ' · ' + a.choices.why : '');

  const card = progress.cards[current.id] || newCard();
  card.mcqTries = (card.mcqTries || 0) + 1;
  if (ok) card.mcqHits = (card.mcqHits || 0) + 1;
  progress.cards[current.id] = card;
  save(LS_PROGRESS, progress);

  reveal();
}

function fmtWhen(ts){
  const d = Math.round((ts - Date.now()) / DAY);
  if (d <= 0) return '곧';
  if (d === 1) return '내일';
  if (d < 30) return d + '일 뒤';
  return Math.round(d/30) + '개월 뒤';
}

async function reveal(){
  if (!current || revealed) return;
  revealed = true;
  $('#btn-reveal').classList.add('hidden');
  $('#recall-hint').classList.add('hidden');

  const a = await getAnswer(current);
  if (a){
    // 요약이 있으면 불릿만 먼저 보여주고 상세는 버튼으로 펼친다
    const bullets = Array.isArray(a.summary) ? a.summary : null;
    $('#a-summary').innerHTML = bullets
      ? bullets.map(b => `<li>${inline(esc(b))}</li>`).join('')
      : '';
    $('#a-summary').classList.toggle('hidden', !bullets);
    $('#btn-more').classList.toggle('hidden', !bullets);
    $('#a-body').classList.toggle('hidden', !!bullets);
    $('#answer').querySelector('h3').textContent = bullets ? '핵심' : '모범답안';
    $('#a-body').innerHTML = md(a.answer);
    const docs = (a.docs || []).map(d =>
      `<a href="https://github.com/fru1tworld/cs-basic/blob/main/docs/${encodeURI(d)}" target="_blank" rel="noopener">${esc(d.split('/').pop().replace(/\.md$/,''))}</a>`
    ).join(' · ');
    $('#a-src').innerHTML =
      (docs ? `근거 문서: ${docs}<br>` : '') +
      (a.source === 'model' ? '이 답변은 레포 docs 에 대응 문서가 없어 일반 지식으로 작성했습니다.' : '');
  } else {
    $('#a-summary').innerHTML = '';
    $('#a-summary').classList.add('hidden');
    $('#btn-more').classList.add('hidden');
    $('#a-body').classList.remove('hidden');
    $('#a-body').innerHTML = '<p>아직 이 문항의 모범답안이 준비되지 않았습니다. 직접 답해보고 평가만 남기세요.</p>';
    $('#a-src').innerHTML = '';
  }

  const card = progress.cards[current.id] || newCard();
  $$('.rate').forEach(b => {
    const g = +b.dataset.g;
    b.querySelector('small').textContent = nextLabel(card, g);
  });
  $('#answer').querySelector('h3').textContent =
    $('#a-summary').classList.contains('hidden') ? '모범답안' : '핵심';
  $('#answer').classList.remove('hidden');
}

function rate(g){
  if (!current) return;
  const id = current.id;
  bumpLog(id);
  const card = progress.cards[id] || newCard();
  const text = $('#c-input').value.trim();
  if (text) card.lastAnswer = text.slice(0, 2000);
  progress.cards[id] = schedule(card, g);
  save(LS_PROGRESS, progress);

  queue.shift();
  if (g === 0) queue.splice(Math.min(queue.length, 6), 0, id);   // 모름이면 같은 세션 뒤쪽에 다시
  showCard();
}

/* ============================ LLM 채점 ============================ */
function gradePrompt(q, modelAnswer, mine){
  return `당신은 한국 IT 기업의 시니어 엔지니어이자 면접관입니다.
아래 CS 면접 질문에 대한 지원자의 답변을 채점하세요.

[질문]
${q.question}

[모범답안]
${modelAnswer || '(준비된 모범답안 없음. 당신의 지식으로 판단하세요.)'}

[지원자 답변]
${mine}

채점 기준:
- 핵심 개념을 정확히 짚었는가 (암기한 문장인지 이해한 설명인지)
- 사실 오류가 있는가
- 면접에서 꼬리질문을 받았을 때 버틸 깊이인가
후하게 주지 마세요. 핵심이 빠졌으면 60점 미만입니다.

반드시 아래 JSON 형식만 출력하세요. 다른 말은 쓰지 마세요.
{"score": 0~100 정수, "verdict": "한 문장 총평",
 "missing": ["빠뜨린 핵심 개념", ...],
 "wrong": ["사실과 다른 부분", ...],
 "followup": "면접관이라면 이어서 던질 꼬리질문 한 개"}`;
}

async function callLLM(prompt){
  const p = config.provider;
  const model = config.model || DEFAULT_MODEL[p] || '';
  if (p === 'gemini'){
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { method:'POST',
        headers:{'Content-Type':'application/json','x-goog-api-key':config.key},
        body: JSON.stringify({
          contents:[{parts:[{text:prompt}]}],
          generationConfig:{temperature:0.2, responseMimeType:'application/json'}
        })});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  // openai 호환 (OpenAI, Ollama, vLLM 등)
  const url = p === 'openai' ? 'https://api.openai.com/v1/chat/completions'
                             : (config.url || 'http://localhost:11434/v1/chat/completions');
  const r = await fetch(url, {
    method:'POST',
    headers: Object.assign({'Content-Type':'application/json'},
      config.key ? {Authorization:'Bearer ' + config.key} : {}),
    body: JSON.stringify({
      model, temperature:0.2,
      response_format:{type:'json_object'},
      messages:[{role:'user', content: prompt}]
    })});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j.choices?.[0]?.message?.content || '';
}

function parseJSON(text){
  try { return JSON.parse(text); } catch {}
  const m = /\{[\s\S]*\}/.exec(text);
  if (m){ try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function grade(){
  if (!current) return;
  const mine = $('#c-input').value.trim();
  if (mine.length < 10){ toast('답을 조금 더 적어주세요'); $('#c-input').focus(); return; }
  if (config.provider === 'none'){ toast('설정에서 채점 제공자를 먼저 고르세요'); return; }
  if (config.provider !== 'custom' && !config.key){ toast('설정에서 API 키를 넣어주세요'); return; }

  const btn = $('#btn-grade');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 채점 중';
  const box = $('#grade-box');
  box.classList.remove('hidden');
  box.innerHTML = '<span class="hint">모범답안과 대조하는 중…</span>';

  try {
    const a = await getAnswer(current);
    const out = await callLLM(gradePrompt(current, a && a.answer, mine));
    const j = parseJSON(out);
    if (!j) throw new Error('응답을 해석하지 못했습니다');

    const score = Math.max(0, Math.min(100, parseInt(j.score, 10) || 0));
    const color = score >= 80 ? 'var(--good)' : score >= 55 ? 'var(--hard)' : 'var(--again)';
    const list = (arr, label) => (Array.isArray(arr) && arr.length)
      ? `<div class="g-label">${label}</div><ul>${arr.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>` : '';
    box.innerHTML =
      `<div class="score"><b style="color:${color}">${score}</b><span>${esc(j.verdict||'')}</span></div>` +
      list(j.missing, '빠진 핵심') + list(j.wrong, '사실과 다른 부분') +
      (j.followup ? `<div class="g-label">예상 꼬리질문</div><p>${esc(j.followup)}</p>` : '');

    const card = progress.cards[current.id] || newCard();
    card.lastScore = score;
    card.bestScore = Math.max(card.bestScore || 0, score);
    progress.cards[current.id] = card;
    const l = progress.log[todayKey()] || (progress.log[todayKey()] = {new:0,rev:0,graded:0});
    l.graded = (l.graded || 0) + 1;
    save(LS_PROGRESS, progress);

    if (!revealed) reveal();
  } catch(e){
    box.innerHTML = `<div class="g-label">채점 실패</div><p>${esc(e.message)}</p>` +
      `<p class="hint">키가 맞는지, 모델 이름이 맞는지, 결제/할당량이 남았는지 설정에서 확인해 보세요.</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '채점';
  }
}

/* ============================ 둘러보기 ============================ */
let browseCat = null, browseLimit = 60;
function renderBrowse(){
  const chips = $('#cat-chips');
  if (!chips.children.length){
    chips.innerHTML = `<button class="on" data-c="">전체</button>` +
      CATS.map(c => `<button data-c="${c.slug}">${esc(c.name)} ${c.count}</button>`).join('');
    chips.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      browseCat = b.dataset.c || null; browseLimit = 60;
      $$('#cat-chips button').forEach(x => x.classList.toggle('on', x === b));
      renderBrowse();
    });
  }
  const term = $('#search').value.trim().toLowerCase();
  const hits = QUESTIONS.filter(q =>
    (!browseCat || q.slug === browseCat) &&
    (!term || q.question.toLowerCase().includes(term)
           || q.section.toLowerCase().includes(term)
           || q.id.toLowerCase().includes(term)));

  const rows = hits.slice(0, browseLimit).map(q => {
    const st = state(q.id);
    const c = progress.cards[q.id];
    const meta = st === 'new' ? '아직 안 봄'
      : (c.reps ? `${fmtWhen(c.due)} 복습` : '학습 중') +
        (c.lastScore != null ? ` · 최근 ${c.lastScore}점` : '');
    return `<div class="bitem" data-id="${q.id}">
      <div class="bq"><span class="dot ${st}"></span>${esc(q.question)}</div>
      <div class="bm">${esc(q.category)} · ${esc(q.section)} · ${q.id} · ${meta}</div></div>`;
  }).join('');

  $('#browse-list').innerHTML = (rows || '<div class="more">결과 없음</div>') +
    (hits.length > browseLimit ? `<div class="more" id="more">${hits.length - browseLimit}개 더 보기</div>` : '');
}

/* ============================ 진도 ============================ */
function renderStats(){
  const cards = Object.values(progress.cards).filter(c => c.seen);
  const mature = cards.filter(c => c.iv >= 21).length;
  const scores = cards.map(c => c.lastScore).filter(x => x != null);
  const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : null;
  $('#stat-top').innerHTML = `
    <div class="stat"><b>${cards.length}</b><span>시작 / ${QUESTIONS.length}</span></div>
    <div class="stat"><b>${mature}</b><span>장기기억 (21일+)</span></div>
    <div class="stat"><b>${avg == null ? '-' : avg}</b><span>평균 채점</span></div>`;

  const heat = [];
  for (let i = 29; i >= 0; i--){
    const d = new Date(Date.now() - i*DAY).toISOString().slice(0,10);
    const l = progress.log[d];
    const n = l ? (l.new||0) + (l.rev||0) : 0;
    const a = n === 0 ? 0 : n < 10 ? .3 : n < 25 ? .55 : n < 50 ? .8 : 1;
    heat.push(`<div class="hcell" title="${d} · ${n}개"${a ? ` style="background:color-mix(in srgb,var(--good) ${a*100}%,var(--panel2))"` : ''}></div>`);
  }
  $('#heat').innerHTML = heat.join('');

  $('#cat-table').innerHTML = CATS.map(c => {
    const ids = QUESTIONS.filter(q => q.slug === c.slug);
    const seen = ids.filter(q => state(q.id) !== 'new').length;
    const pct = Math.round(seen / ids.length * 100);
    return `<div class="ct-row"><div class="ct-name">${esc(c.name)}</div>
      <div class="ct-bar"><i style="width:${pct}%"></i></div>
      <div class="ct-num">${seen}/${ids.length}</div></div>`;
  }).join('');
}

/* ============================ 설정 ============================ */
function renderSettings(){
  $('#s-new').value = config.newPerDay;
  $('#s-max').value = config.maxPerDay;
  $('#s-provider').value = config.provider;
  $('#s-key').value = config.key;
  $('#s-model').value = config.model;
  $('#s-model').placeholder = DEFAULT_MODEL[config.provider] || '';
  $('#s-url').value = config.url;
  $('#s-url-field').classList.toggle('hidden', config.provider !== 'custom');
  $('#s-key').closest('.field').classList.toggle('hidden', config.provider === 'none');
  $('#s-model').closest('.field').classList.toggle('hidden', config.provider === 'none');
  $('#s-test').classList.toggle('hidden', config.provider === 'none');

  $('#s-cat-list').innerHTML = CATS.map(c =>
    `<button data-c="${c.slug}" class="${catEnabled(c.slug) ? 'on' : ''}">${esc(c.name)}</button>`).join('');
}

function saveConfig(){ save(LS_CONFIG, config); }

function renderMode(){
  $$('#mode-switch button').forEach(b => {
    b.classList.toggle('on', b.dataset.m === config.mode);
    // 선택지가 하나도 없으면 객관식 모드를 막는다
    if (b.dataset.m !== 'write') b.disabled = MCQ.size === 0;
  });
}

/* ============================ 이벤트 ============================ */
function wire(){
  $('#topbar').addEventListener('click', e => {
    const b = e.target.closest('.tab'); if (!b) return;
    $$('.tab').forEach(t => t.classList.toggle('on', t === b));
    $$('.view').forEach(v => v.classList.toggle('on', v.id === b.dataset.view));
    if (b.dataset.view === 'browse') renderBrowse();
    if (b.dataset.view === 'stats') renderStats();
    if (b.dataset.view === 'settings') renderSettings();
    window.scrollTo({top:0});
  });

  $('#mode-switch').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    config.mode = b.dataset.m;
    saveConfig(); renderMode(); buildQueue(); showCard();
  });

  $('#choices').addEventListener('click', e => {
    const b = e.target.closest('.opt');
    if (b) pickChoice(b);
  });

  $('#btn-reveal').addEventListener('click', reveal);
  $('#btn-more').addEventListener('click', () => {
    $('#a-body').classList.remove('hidden');
    $('#btn-more').classList.add('hidden');
  });
  $('#btn-grade').addEventListener('click', grade);
  $('#answer').addEventListener('click', e => {
    const b = e.target.closest('.rate'); if (b) rate(+b.dataset.g);
  });
  $('#btn-extra').addEventListener('click', () => { buildQueue(10); showCard(); });

  $('#search').addEventListener('input', () => { browseLimit = 60; renderBrowse(); });
  $('#browse-list').addEventListener('click', e => {
    if (e.target.id === 'more'){ browseLimit += 120; renderBrowse(); return; }
    const it = e.target.closest('.bitem'); if (!it) return;
    // 지금 바로 이 문항으로 건너뛴다
    queue = [it.dataset.id].concat(queue.filter(x => x !== it.dataset.id));
    $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === 'study'));
    $$('.view').forEach(v => v.classList.toggle('on', v.id === 'study'));
    showCard();
  });

  $('#s-new').addEventListener('change', e => {
    config.newPerDay = Math.max(0, +e.target.value || 0); saveConfig(); buildQueue(); renderQueueBar(); });
  $('#s-max').addEventListener('change', e => {
    config.maxPerDay = Math.max(5, +e.target.value || 5); saveConfig(); buildQueue(); renderQueueBar(); });
  $('#s-provider').addEventListener('change', e => {
    config.provider = e.target.value;
    if (!config.model) $('#s-model').placeholder = DEFAULT_MODEL[config.provider] || '';
    saveConfig(); renderSettings(); });
  $('#s-key').addEventListener('change', e => { config.key = e.target.value.trim(); saveConfig(); });
  $('#s-model').addEventListener('change', e => { config.model = e.target.value.trim(); saveConfig(); });
  $('#s-url').addEventListener('change', e => { config.url = e.target.value.trim(); saveConfig(); });

  $('#s-cat-list').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const all = CATS.map(c => c.slug);
    let on = config.cats ? config.cats.slice() : all.slice();
    const i = on.indexOf(b.dataset.c);
    if (i >= 0) on.splice(i, 1); else on.push(b.dataset.c);
    config.cats = on.length === all.length ? null : on;
    saveConfig(); renderSettings(); buildQueue();
  });

  $('#s-test').addEventListener('click', async () => {
    const out = $('#s-test-out');
    out.innerHTML = '<span class="spin"></span> 확인 중…';
    try {
      const r = await callLLM('아래 JSON 만 출력하세요. {"score":100,"verdict":"연결됨","missing":[],"wrong":[],"followup":""}');
      out.textContent = parseJSON(r) ? '연결 성공' : '응답은 왔지만 JSON 형식이 아닙니다: ' + r.slice(0,120);
    } catch(e){ out.textContent = '실패: ' + e.message; }
  });

  $('#s-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(progress)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cs-study-${todayKey()}.json`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  });
  $('#s-import').addEventListener('click', () => $('#s-file').click());
  $('#s-file').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j.cards) throw new Error('형식이 맞지 않습니다');
      // 더 많이 복습한 쪽을 남기는 병합
      for (const [id, c] of Object.entries(j.cards)){
        const cur = progress.cards[id];
        if (!cur || (c.seen || 0) > (cur.seen || 0)) progress.cards[id] = c;
      }
      Object.assign(progress.log, j.log || {});
      save(LS_PROGRESS, progress);
      buildQueue(); showCard();
      toast('가져왔습니다');
    } catch(err){ toast('가져오기 실패: ' + err.message); }
    e.target.value = '';
  });
  $('#s-reset').addEventListener('click', () => {
    if (!confirm('진도를 전부 지웁니다. 되돌릴 수 없습니다.')) return;
    progress = {cards:{}, log:{}};
    save(LS_PROGRESS, progress);
    buildQueue(); showCard(); renderSettings();
    toast('초기화했습니다');
  });

  // 키보드 (맥에서 볼 때)
  document.addEventListener('keydown', e => {
    if (!$('#study').classList.contains('on')) return;
    if (e.target.matches('textarea,input,select')) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); revealed ? null : reveal(); }
      return;
    }
    if (e.key === ' '){
      e.preventDefault();
      if (!revealed) reveal();
      else if (!$('#btn-more').classList.contains('hidden')) $('#btn-more').click();
    }
    if (asChoice && !answered && ['1','2','3','4'].includes(e.key)){
      const b = $$('.opt')[+e.key - 1];
      if (b) { pickChoice(b); return; }
    }
    if (revealed && ['1','2','3'].includes(e.key)) rate(+e.key - 1);
  });
}

/* ============================ 시작 ============================ */
async function main(){
  wire();
  try {
    const [q, c] = await Promise.all([
      fetch('data/questions.json').then(r => r.json()),
      fetch('data/categories.json').then(r => r.json()),
    ]);
    QUESTIONS = q; CATS = c;
    BY_ID = new Map(q.map(x => [x.id, x]));
    try {
      MCQ = new Set(await fetch('data/mcq-index.json').then(r => r.json()));
    } catch { MCQ = new Set(); }
    if (config.mode !== 'write' && MCQ.size === 0) config.mode = 'write';
  } catch(e){
    $('#queue-bar').textContent = '데이터를 불러오지 못했습니다: ' + e.message;
    return;
  }
  $('#s-build').textContent = `질문 ${QUESTIONS.length}개 · 출처 github.com/fru1tworld/cs-basic`;
  renderMode();
  buildQueue();
  showCard();

  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}
main();
